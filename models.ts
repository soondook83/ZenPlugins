import { Account } from '../../types/zenmoney'

export interface Preferences {
  phone: string
  startDate?: string
}

// АТБ-Онлайн привязывает сессию к конкретному "устройству" (deviceId).
// Один раз устройство подтверждается телефон+SMS-код+номер карты (enrollment),
// дальше вход выполняется по телефону+deviceId без повторного OTP (пока банк не отзовёт доверие к устройству).
export interface Auth {
  deviceId: string
  cookieHeader: string
  updatedAt: string
}

export interface Session {
  auth: Auth
}

export enum ProductType {
  card = 'CARD',
  // "До востребования" / текущие счета — у операций banка нет подтверждённого
  // отдельного значения productType, поэтому история по ним не запрашивается (см. fetchApi.ts)
  account = 'ACCOUNT'
}

// Один зенмани-счёт может объединять несколько карт банка,
// если у них совпадает номер счёта (физическая + цифровая карта на одном счёте)
export interface Product {
  // значение поля cardId карты (используется как productId в запросе операций)
  id: string
  type: ProductType
}

export interface ConvertedAccount {
  account: Account
  products: Product[]
}
