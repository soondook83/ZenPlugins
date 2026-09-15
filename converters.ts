import { getNumber, getOptBoolean, getOptNumber, getOptString, getString } from '../../types/get'
import { Account, AccountType, NonParsedMerchant, Transaction } from '../../types/zenmoney'
import { ConvertedAccount, Product, ProductType } from './models'

function cleanCardNumber (maskCardNumber: string): string {
  return maskCardNumber.replace(/\s/g, '')
}

export function convertAccounts (cardsRaw: unknown[], depositsRaw: unknown[]): ConvertedAccount[] {
  const cardGroupsByAccountNumber = new Map<string, unknown[]>()
  for (const card of cardsRaw) {
    const accountNumber = getString(card, 'accountNumber')
    const group = cardGroupsByAccountNumber.get(accountNumber) ?? []
    group.push(card)
    cardGroupsByAccountNumber.set(accountNumber, group)
  }

  const result: ConvertedAccount[] = []

  for (const [accountNumber, cards] of cardGroupsByAccountNumber) {
    // Одна и та же карта может быть представлена и физическим, и цифровым
    // "лицом" — у них общий accountNumber и баланс, но разные cardId
    // (нужны отдельно, чтобы запросить операции по каждому из них).
    const primary = cards[0]
    const isCreditCard = cards.some(card => getOptBoolean(card, 'isCreditCard') === true)
    const creditLimit = cards.map(card => getOptNumber(card, 'creditLimit')).find(value => value != null) ?? null
    const totalDebt = cards.map(card => getOptNumber(card, 'totalDebt')).find(value => value != null) ?? null

    const account: Account = {
      id: accountNumber,
      type: AccountType.ccard,
      title: getOptString(primary, 'cardNameToDisplay') ?? getOptString(primary, 'cardTariff') ?? 'Карта АТБ',
      instrument: getString(primary, 'currency'),
      syncIds: [accountNumber, ...cards.map(card => cleanCardNumber(getString(card, 'maskCardNumber')))],
      balance: Number(getString(primary, 'balance')),
      creditLimit: isCreditCard ? creditLimit : null,
      totalAmountDue: isCreditCard ? totalDebt : null
    }

    const products: Product[] = cards.map(card => ({ id: getString(card, 'cardId'), type: ProductType.card }))
    result.push({ account, products })
  }

  for (const deposit of depositsRaw) {
    const accountNumber = getString(deposit, 'accountNumber')
    // "До востребования" — это по сути текущий счёт, а не срочный вклад
    // (нет даты окончания/капитализации), поэтому используем checking, а не deposit.
    const account: Account = {
      id: accountNumber,
      type: AccountType.checking,
      title: getOptString(deposit, 'contractType') ?? 'Счёт АТБ',
      instrument: getString(deposit, 'currency'),
      syncIds: [accountNumber],
      balance: getNumber(deposit, 'balance')
    }
    result.push({ account, products: [{ id: getString(deposit, 'id'), type: ProductType.account }] })
  }

  return result
}

function buildMerchant (operation: unknown): NonParsedMerchant | null {
  const mcc = getOptString(operation, 'merchant.mcc')
  const title = getOptString(operation, 'title') ?? getOptString(operation, 'name')
  if (mcc != null) {
    return {
      fullTitle: title ?? getOptString(operation, 'categoryName') ?? 'Покупка',
      mcc: Number(mcc),
      location: null,
      category: getOptString(operation, 'categoryName')
    }
  }
  const correspondent = getOptString(operation, 'correspondent') ?? getOptString(operation, 'corrName')
  if (correspondent != null) {
    return { fullTitle: correspondent, mcc: null, location: null }
  }
  if (title != null) {
    return { fullTitle: title, mcc: null, location: null }
  }
  return null
}

export function convertTransaction (operation: unknown, account: Account): Transaction {
  const status = getOptString(operation, 'status')
  const changeType = getOptString(operation, 'changeType')
  const sign = changeType === 'DECREASE' ? -1 : 1

  const operationAmount = getOptNumber(operation, 'operationAmount.amount')
  const transactionAmount = getOptNumber(operation, 'transactionAmount.amount')
  const transactionCurrency = getOptString(operation, 'transactionAmount.currency')
  const amount = operationAmount ?? transactionAmount ?? 0

  const fee = getOptNumber(operation, 'feeAmount.amount') ?? 0

  const invoice = transactionCurrency != null && transactionCurrency !== account.instrument && transactionAmount != null
    ? { sum: sign * transactionAmount, instrument: transactionCurrency }
    : null

  const dateString = getOptString(operation, 'transactionDate') ?? getString(operation, 'operationDate')

  return {
    hold: status != null && status !== 'PROCESSED',
    date: new Date(dateString),
    movements: [
      {
        id: getOptString(operation, 'id') ?? null,
        account: { id: account.id },
        invoice,
        sum: sign * amount,
        fee
      }
    ],
    merchant: buildMerchant(operation),
    comment: getOptString(operation, 'purpose') ?? null
  }
}

export function convertTransactions (operations: unknown[], account: Account): Transaction[] {
  return operations.map(operation => convertTransaction(operation, account))
}
