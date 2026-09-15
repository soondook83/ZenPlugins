import crypto from 'crypto-js'
import { fetchJson, FetchResponse } from '../../common/network'
import { generateUUID } from '../../common/utils'
import { getArray, getOptString, getString } from '../../types/get'
import { InvalidLoginOrPasswordError, InvalidOtpCodeError, TemporaryUnavailableError } from '../../errors'
import { Auth, Preferences } from './models'

const gatewayBaseUrl = 'https://mobile.atb.su/atb-gateway/mobile'

function getHeaderValue (response: FetchResponse, name: string): string | undefined {
  const headers = response.headers as Record<string, string | undefined>
  return headers[name.toLowerCase()] ?? headers[name]
}

function mergeCookieHeaders (currentCookieHeader: string, setCookieHeader: string | undefined): string {
  if (setCookieHeader == null || setCookieHeader === '') {
    return currentCookieHeader
  }
  const cookies: Record<string, string> = {}
  for (const cookiePair of currentCookieHeader.split(';')) {
    const separator = cookiePair.indexOf('=')
    if (separator > 0) {
      cookies[cookiePair.slice(0, separator).trim()] = cookiePair.slice(separator + 1).trim()
    }
  }
  // Set-Cookie for several cookies is joined by the network layer with ', ' —
  // this only splits on commas that precede a new "name=" pair (a plain comma
  // can legally appear inside a cookie value, e.g. in Expires=).
  const parts: string[] = []
  let start = 0
  for (let i = 0; i < setCookieHeader.length; i++) {
    if (setCookieHeader[i] !== ',') continue
    let j = i + 1
    while (setCookieHeader[j] === ' ') j++
    if (/^[^;=,]+=/.test(setCookieHeader.slice(j))) {
      parts.push(setCookieHeader.slice(start, i).trim())
      start = j
    }
  }
  parts.push(setCookieHeader.slice(start).trim())
  for (const part of parts) {
    const pair = part.split(';', 1)[0]
    const separator = pair.indexOf('=')
    if (separator > 0) {
      cookies[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim()
    }
  }
  return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ')
}

export function generateDeviceId (): string {
  return generateUUID()
}

// Нормализует номер телефона к виду, который ожидает АТБ: 10 цифр без ведущей 7/8.
export function normalizePhone (phone: string): number {
  const digits = phone.replace(/\D/g, '').replace(/^7|^8/, '')
  if (digits.length !== 10) {
    throw new InvalidLoginOrPasswordError('Некорректный номер телефона')
  }
  return Number(digits)
}

interface CookieState {
  cookieHeader: string
}

async function gatewayFetch (path: string, cookieState: CookieState, options: {
  method?: string
  body?: unknown
  query?: Record<string, string>
} = {}): Promise<FetchResponse> {
  const query = options.query != null ? '?' + new URLSearchParams(options.query).toString() : ''
  const response = await fetchJson(`${gatewayBaseUrl}${path}${query}`, {
    method: options.method ?? 'GET',
    ...options.body !== undefined && { body: options.body },
    headers: {
      ...(cookieState.cookieHeader !== '' ? { Cookie: cookieState.cookieHeader } : undefined)
    },
    sanitizeRequestLog: {
      headers: { Cookie: true, cookie: true },
      body: { otp: true, hashCardNumber: true }
    },
    sanitizeResponseLog: {
      headers: { 'set-cookie': true },
      body: { sessionId: true, successAuth: true, regSessionId: true }
    }
  })
  cookieState.cookieHeader = mergeCookieHeaders(cookieState.cookieHeader, getHeaderValue(response, 'set-cookie'))
  if (response.status === 401 || response.status === 403) {
    throw new TemporaryUnavailableError()
  }
  return response
}

// === Вход / привязка устройства ===
// АТБ-Онлайн привязывает сессию к паре (телефон, deviceId). Для незнакомого
// устройства требуется полная процедура: телефон -> SMS-код -> номер карты.
// Для уже подтверждённого устройства достаточно шага login-ib (см. fetchLoginIb).

export async function fetchEnrollmentStart (phone: number, deviceId: string, cookieState: CookieState): Promise<{ enrollmentId: string }> {
  const response = await gatewayFetch('/enrollment/start-ib', cookieState, {
    method: 'POST',
    body: { login: phone, phoneDeviceRequest: { deviceId, osType: 'OTHER' } }
  })
  const command = getOptString(response.body, 'command')
  if (command !== 'SHOW_OTP_PAGE') {
    throw new TemporaryUnavailableError()
  }
  return { enrollmentId: getString(response.body, 'id') }
}

export async function fetchEnrollmentConfirm (enrollmentId: string, otp: string, cookieState: CookieState): Promise<void> {
  const response = await gatewayFetch('/enrollment/confirm-ib', cookieState, {
    method: 'POST',
    body: { id: enrollmentId, otp }
  })
  const command = getOptString(response.body, 'command')
  if (command == null) {
    throw new InvalidOtpCodeError()
  }
}

// ВНИМАНИЕ: точный алгоритм вычисления hashCardNumber не подтверждён живым тестом
// (см. пояснение в README/чате) — реализован как SHA-256 от номера карты (без пробелов).
// Если банк отклонит запрос, это первое место для проверки через DevTools.
export async function fetchCardCheck (cardNumber: string, cookieState: CookieState): Promise<void> {
  const hashCardNumber = crypto.SHA256(cardNumber.replace(/\D/g, '')).toString(crypto.enc.Hex)
  const response = await gatewayFetch('/entry/checker/client/card-ib', cookieState, {
    method: 'POST',
    body: { hashCardNumber, hmacFlag: true }
  })
  const command = getOptString(response.body, 'command')
  if (command !== 'SHOW_MAIN_PAGE') {
    throw new InvalidLoginOrPasswordError('Банк не подтвердил номер карты')
  }
}

export async function fetchLoginIb (phone: number, deviceId: string, cookieState: CookieState): Promise<void> {
  const response = await gatewayFetch('/session/v1/login-ib', cookieState, {
    method: 'POST',
    body: { language: 'RU', login: phone, phoneDeviceRequest: { deviceId, osType: 'OTHER' } }
  })
  const command = getOptString(response.body, 'command')
  if (command !== 'SHOW_MAIN_PAGE') {
    throw new TemporaryUnavailableError()
  }
}

export async function fetchClientInfo (auth: Auth): Promise<unknown> {
  const cookieState: CookieState = { cookieHeader: auth.cookieHeader }
  const response = await gatewayFetch('/entry/client/info', cookieState)
  return response.body
}

// === Продукты ===

export async function fetchCards (auth: Auth): Promise<unknown[]> {
  const cookieState: CookieState = { cookieHeader: auth.cookieHeader }
  const response = await gatewayFetch('/dcrd/v2/cards', cookieState, { query: { isOnlyActiveCard: 'true' } })
  return getArray(response.body, '')
}

export async function fetchDeposits (auth: Auth): Promise<unknown[]> {
  const cookieState: CookieState = { cookieHeader: auth.cookieHeader }
  const response = await gatewayFetch('/api/mdic/v1/client/deposits/list', cookieState)
  return getArray(response.body, 'data')
}

// Кредиты банк вернул пустым списком при разработке плагина — формат отдельного
// кредита не был подтверждён на реальных данных, поэтому конвертация в счёт
// пока не реализована (см. converters.ts). Список получаем, чтобы не потерять
// эти продукты молча — при непустом ответе выводим предупреждение в лог.
export async function fetchCredits (auth: Auth): Promise<unknown[]> {
  const cookieState: CookieState = { cookieHeader: auth.cookieHeader }
  const response = await gatewayFetch('/mspl-dbmf-aggregator/v1/credits', cookieState)
  return getArray(response.body, '')
}

function formatDate (date: Date): string {
  return date.toISOString().slice(0, 10)
}

export async function fetchCardOperations (auth: Auth, cardId: string, fromDate: Date, toDate: Date): Promise<unknown[]> {
  const cookieState: CookieState = { cookieHeader: auth.cookieHeader }
  const response = await gatewayFetch('/api/msfl/v3/operations', cookieState, {
    query: {
      groupingOperation: 'true',
      timezone: '+03:00',
      productId: cardId,
      productType: 'CARD',
      dateFrom: formatDate(fromDate),
      dateTo: formatDate(toDate)
    }
  })
  const dateGroups = getArray(response.body, 'operationsPerDates')
  const operations: unknown[] = []
  for (const group of dateGroups) {
    operations.push(...getArray(group, 'operations'))
  }
  return operations
}
