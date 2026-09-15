import { InvalidLoginOrPasswordError, InvalidOtpCodeError, TemporaryUnavailableError } from '../../errors'
import {
  fetchCardCheck,
  fetchCardOperations,
  fetchCards,
  fetchClientInfo,
  fetchCredits,
  fetchDeposits,
  fetchEnrollmentConfirm,
  fetchEnrollmentStart,
  fetchLoginIb,
  generateDeviceId,
  normalizePhone
} from './fetchApi'
import { Auth, Preferences, Product, ProductType, Session } from './models'

// Сессия банка живёт недолго — не пытаемся переиспользовать её между запусками,
// но deviceId (доверенное устройство) переиспользуем всегда, чтобы не спрашивать
// SMS-код и номер карты при каждой синхронизации.
async function loginWithKnownDevice (phone: number, deviceId: string): Promise<Auth> {
  const cookieState = { cookieHeader: '' }
  await fetchLoginIb(phone, deviceId, cookieState)
  return { deviceId, cookieHeader: cookieState.cookieHeader, updatedAt: new Date().toISOString() }
}

async function enrollNewDevice (phone: number, deviceId: string): Promise<Auth> {
  const cookieState = { cookieHeader: '' }
  const { enrollmentId } = await fetchEnrollmentStart(phone, deviceId, cookieState)

  const otp = await ZenMoney.readLine('Введите код из SMS для входа в АТБ-Онлайн', { inputType: 'number' })
  if (otp == null || otp.trim() === '') {
    throw new InvalidOtpCodeError()
  }
  await fetchEnrollmentConfirm(enrollmentId, otp.trim(), cookieState)

  // Новое устройство банк подтверждает номером карты — запрашиваем один раз,
  // при последующих синхронизациях этот шаг не повторяется.
  const cardNumber = await ZenMoney.readLine(
    'Новое устройство: введите полный номер любой вашей карты АТБ для подтверждения',
    { inputType: 'number' }
  )
  if (cardNumber == null || cardNumber.trim() === '') {
    throw new InvalidLoginOrPasswordError('Не указан номер карты для подтверждения устройства')
  }
  await fetchCardCheck(cardNumber.trim(), cookieState)

  await fetchLoginIb(phone, deviceId, cookieState)
  return { deviceId, cookieHeader: cookieState.cookieHeader, updatedAt: new Date().toISOString() }
}

export async function login (preferences: Preferences, auth?: Auth): Promise<Session> {
  const phone = normalizePhone(preferences.phone)

  if (auth?.deviceId != null) {
    try {
      return { auth: await loginWithKnownDevice(phone, auth.deviceId) }
    } catch (e) {
      // Устройство могло "забыться" банком (долгий перерыв, отзыв доверия) —
      // в этом случае честно проходим полный enrollment ещё раз.
      if (!(e instanceof TemporaryUnavailableError || e instanceof InvalidLoginOrPasswordError)) {
        throw e
      }
    }
  }

  const deviceId = auth?.deviceId ?? generateDeviceId()
  return { auth: await enrollNewDevice(phone, deviceId) }
}

export async function fetchAccounts (session: Session): Promise<{ cards: unknown[], deposits: unknown[] }> {
  const [cards, deposits, credits] = await Promise.all([
    fetchCards(session.auth),
    fetchDeposits(session.auth),
    fetchCredits(session.auth)
  ])
  if (credits.length > 0) {
    console.log('atb-ru: получены кредитные продукты, но их конвертация пока не реализована', credits)
  }
  return { cards, deposits }
}

export async function fetchClient (session: Session): Promise<unknown> {
  return await fetchClientInfo(session.auth)
}

export async function fetchTransactions (session: Session, product: Product, fromDate: Date, toDate: Date): Promise<unknown[]> {
  if (product.type !== ProductType.card) {
    // История по текущим/накопительным счетам ("До востребования") через этот
    // эндпоинт не подтверждена реальными данными — см. models.ts/fetchApi.ts.
    return []
  }
  return await fetchCardOperations(session.auth, product.id, fromDate, toDate)
}
