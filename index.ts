import { Account, ScrapeFunc, Transaction } from '../../types/zenmoney'
import { fetchAccounts, fetchTransactions, login } from './api'
import { convertAccounts, convertTransactions } from './converters'
import { Auth, Preferences } from './models'

export const scrape: ScrapeFunc<Preferences> = async ({ preferences, fromDate, toDate }) => {
  const session = await login(preferences, ZenMoney.getData('auth') as Auth | undefined)
  ZenMoney.setData('auth', session.auth)
  ZenMoney.saveData()

  const { cards, deposits } = await fetchAccounts(session)
  const convertedAccounts = convertAccounts(cards, deposits)

  const accounts: Account[] = convertedAccounts.map(({ account }) => account)
  const transactions: Transaction[] = []

  await Promise.all(convertedAccounts.map(async ({ account, products }) => {
    if (ZenMoney.isAccountSkipped(account.id)) {
      return
    }
    await Promise.all(products.map(async product => {
      const operations = await fetchTransactions(session, product, fromDate, toDate ?? new Date())
      transactions.push(...convertTransactions(operations, account))
    }))
  }))

  return { accounts, transactions }
}
