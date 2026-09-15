import { AccountType } from '../../../types/zenmoney'
import { convertAccounts, convertTransaction } from '../converters'

// Данные ниже — анонимизированный слепок реального ответа API АТБ
// (my.atb.su -> mobile.atb.su/atb-gateway/mobile), с заменёнными
// именем, номерами карт и счетов.

const physicalCard = {
  id: '11111111-1111-1111-1111-111111111111',
  cardId: '100000000001',
  uuid: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  maskCardNumber: '400000****0001',
  cardholderName: 'IVAN IVANOV',
  paymentSystemType: 'Visa',
  balance: '1000',
  currency: 'RUB',
  accountNumber: '40817810000000000001',
  status: '00',
  expDate: '06/26',
  issueDate: '07/23',
  cardType: 'Visa Gold',
  isDigitalCard: false,
  isCreditCard: false,
  cardName: null,
  cardNameToDisplay: 'АТБ карта',
  productId: '200000000001'
}

const digitalTwinOfSameAccount = {
  ...physicalCard,
  id: '22222222-2222-2222-2222-222222222222',
  cardId: '100000000002',
  maskCardNumber: '400000****0002',
  isDigitalCard: true,
  productId: '200000000002'
}

const creditCard = {
  ...physicalCard,
  id: '33333333-3333-3333-3333-333333333333',
  cardId: '100000000003',
  maskCardNumber: '400000****0003',
  accountNumber: '40817810000000000003',
  balance: '0',
  isCreditCard: true,
  creditLimit: 50000,
  totalDebt: 12345.67
}

const demandDeposit = {
  id: '300000000001',
  contractNumber: '0001234',
  contractType: 'До востребования "Личный счет"',
  accountNumber: '42301810000000001234',
  rate: 0.01,
  balance: 0,
  currency: 'RUB',
  status: 'WORK',
  startDate: '2023-06-21',
  endDate: null
}

describe('convertAccounts', () => {
  it('groups physical and digital cards sharing the same account into a single zenmoney account', () => {
    const { account, products } = convertAccounts([physicalCard, digitalTwinOfSameAccount], [])[0]
    expect(account.type).toEqual(AccountType.ccard)
    expect(account.id).toEqual('40817810000000000001')
    expect(account.balance).toEqual(1000)
    expect(account.syncIds).toEqual(expect.arrayContaining(['40817810000000000001', '400000****0001', '400000****0002']))
    expect(products).toEqual([
      { id: '100000000001', type: 'CARD' },
      { id: '100000000002', type: 'CARD' }
    ])
  })

  it('fills creditLimit/totalAmountDue only for credit cards', () => {
    const [{ account: debitAccount }] = convertAccounts([physicalCard], [])
    expect(debitAccount.creditLimit).toBeNull()

    const [{ account: creditAccount }] = convertAccounts([creditCard], [])
    expect(creditAccount.creditLimit).toEqual(50000)
    expect(creditAccount.totalAmountDue).toEqual(12345.67)
  })

  it('maps "до востребования" accounts to checking, not deposit', () => {
    const [{ account, products }] = convertAccounts([], [demandDeposit])
    expect(account.type).toEqual(AccountType.checking)
    expect(account.id).toEqual('42301810000000001234')
    expect(account.balance).toEqual(0)
    expect(products).toEqual([{ id: '300000000001', type: 'ACCOUNT' }])
  })
})

describe('convertTransaction', () => {
  const [{ account }] = convertAccounts([physicalCard], [])

  it('converts a completed card purchase as an outcome with merchant', () => {
    const operation = {
      id: '9000000001',
      productId: '100000000001',
      productType: 'CARD',
      changeType: 'DECREASE',
      status: 'PROCESSED',
      operationDate: '2026-09-10T00:00:00+03:00',
      transactionDate: '2026-09-10T21:15:46+03:00',
      name: 'SOME CAFE',
      title: 'SOME CAFE',
      type: 'Покупки',
      operationType: 'PayService',
      merchant: { mcc: '5812' },
      operationAmount: { amount: 360.0, currency: 'RUB' },
      transactionAmount: { amount: 360.0, currency: 'RUB' },
      feeAmount: {},
      category: 'restaurants',
      categoryName: 'Рестораны'
    }
    const transaction = convertTransaction(operation, account)
    expect(transaction.hold).toEqual(false)
    expect(transaction.date).toEqual(new Date('2026-09-10T21:15:46+03:00'))
    expect(transaction.movements).toEqual([
      { id: '9000000001', account: { id: account.id }, invoice: null, sum: -360, fee: 0 }
    ])
    expect(transaction.merchant).toEqual({ fullTitle: 'SOME CAFE', mcc: 5812, location: null, category: 'Рестораны' })
  })

  it('marks an authorization-hold operation as hold', () => {
    const operation = {
      id: '9000000002',
      changeType: 'DECREASE',
      status: 'IN_PROGRESS',
      messageClass: 'AUTHORIZATION',
      transactionDate: '2026-09-15T13:43:32+03:00',
      title: 'SOME SHOP',
      merchant: { mcc: '5814' },
      operationAmount: { amount: 230.0, currency: 'RUB' },
      transactionAmount: { amount: 230.0, currency: 'RUB' },
      feeAmount: {}
    }
    const transaction = convertTransaction(operation, account)
    expect(transaction.hold).toEqual(true)
    expect(transaction.movements[0].sum).toEqual(-230)
  })

  it('converts an incoming transfer using the correspondent name as merchant', () => {
    const operation = {
      id: '9000000003',
      changeType: 'INCREASE',
      status: 'PROCESSED',
      transactionDate: '2026-09-13T16:59:25+03:00',
      name: 'Перевод по номеру телефона',
      operationType: 'TransferMe2Me',
      corrName: 'ИВАН И',
      correspondent: 'ИВАН И',
      operationAmount: { amount: 5000.0, currency: 'RUB' },
      transactionAmount: { amount: 5000.0, currency: 'RUB' },
      feeAmount: {}
    }
    const transaction = convertTransaction(operation, account)
    expect(transaction.movements[0].sum).toEqual(5000)
    expect(transaction.merchant).toEqual({ fullTitle: 'ИВАН И', mcc: null, location: null })
  })
})
