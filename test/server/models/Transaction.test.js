import { expect } from 'chai';
import { stub } from 'sinon';

import { TransactionKind } from '../../../server/constants/transaction-kind';
import models from '../../../server/models';
import {
  fakeCollective,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeTransaction,
  fakeUser,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

const { Transaction } = models;

const transactionsData = utils.data('transactions1').transactions;

const SNAPSHOT_COLUMNS = [
  'kind',
  'type',
  'netAmountInCollectiveCurrency',
  'currency',
  'HostCollectiveId',
  'platformFeeInHostCurrency',
  'paymentProcessorFeeInHostCurrency',
  'taxAmount',
  'amount',
  'description',
];

const SNAPSHOT_COLUMNS_WITH_DEBT = [
  'kind',
  'type',
  'isDebt',
  'FromCollectiveId',
  'CollectiveId',
  'HostCollectiveId',
  'amount',
  'currency',
  'platformFeeInHostCurrency',
  'paymentProcessorFeeInHostCurrency',
  'settlementStatus',
  'description',
];

describe('server/models/Transaction', () => {
  let user, host, inc, collective, defaultTransactionData;

  beforeEach(() => utils.resetTestDB());

  beforeEach(async () => {
    user = await fakeUser({}, { name: 'User' });
    inc = await fakeHost({
      id: 8686,
      slug: 'opencollectiveinc',
      name: 'Open Collective',
      CreatedByUserId: user.id,
      HostCollectiveId: 8686,
    });
    host = await fakeHost({
      name: 'Random Host',
      CreatedByUserId: user.id,
    });
    collective = await fakeCollective({
      HostCollectiveId: host.id,
      CreatedByUserId: user.id,
      name: 'Collective',
    });
    defaultTransactionData = {
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
    };
  });

  it('automatically generates uuid', done => {
    Transaction.create({
      amount: -1000,
      ...defaultTransactionData,
    })
      .then(transaction => {
        expect(transaction.info.uuid).to.match(
          /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i,
        );
        done();
      })
      .catch(done);
  });

  it('get the host', done => {
    Transaction.create({
      ...defaultTransactionData,
      amount: 10000,
    }).then(transaction => {
      expect(transaction.HostCollectiveId).to.equal(host.id);
      done();
    });
  });

  it('createFromContributionPayload creates a double entry transaction for a Stripe payment in EUR with VAT', () => {
    const transactionPayload = {
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      description: '€121 for Vegan Burgers including €21 VAT',
      amount: 12100,
      amountInHostCurrency: 12100,
      currency: 'EUR',
      hostCurrency: 'EUR',
      hostCurrencyFxRate: 1,
      platformFeeInHostCurrency: 500,
      hostFeeInHostCurrency: 500,
      paymentProcessorFeeInHostCurrency: 300,
      taxAmount: 2100,
      type: 'CREDIT',
      createdAt: '2015-05-29T07:00:00.000Z',
      PaymentMethodId: 1,
    };

    return Transaction.createFromContributionPayload(transactionPayload).then(() => {
      return Transaction.findAll().then(transactions => {
        utils.snapshotTransactions(transactions, { columns: SNAPSHOT_COLUMNS });

        expect(transactions.length).to.equal(4);

        const contributions = transactions.filter(t => t.kind === TransactionKind.CONTRIBUTION);

        expect(contributions.length).to.equal(2);
        expect(contributions[0].kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(contributions[0].type).to.equal('DEBIT');
        expect(contributions[0].netAmountInCollectiveCurrency).to.equal(-12100);
        expect(contributions[0].currency).to.equal('EUR');
        expect(contributions[0].HostCollectiveId).to.be.null;

        expect(contributions[1].kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(contributions[1].type).to.equal('CREDIT');
        expect(contributions[1].amount).to.equal(12100);
        expect(contributions[1].platformFeeInHostCurrency).to.equal(-500);
        expect(contributions[1].hostFeeInHostCurrency).to.equal(0);
        expect(contributions[1].paymentProcessorFeeInHostCurrency).to.equal(-300);
        expect(contributions[1].taxAmount).to.equal(-2100);
        expect(contributions[1].amount).to.equal(12100);
        expect(contributions[1].netAmountInCollectiveCurrency).to.equal(9200);
        expect(contributions[0] instanceof models.Transaction).to.be.true;
        expect(contributions[0].description).to.equal(transactionPayload.description);
      });
    });
  });

  it('createFromContributionPayload creates a double entry transaction for a Stripe donation in EUR on a USD host', () => {
    const transactionPayload = {
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      description: '€100 donation to WWCode Berlin',
      amount: 10000,
      amountInHostCurrency: 11000,
      currency: 'EUR',
      hostCurrency: 'USD',
      hostCurrencyFxRate: 1.1,
      platformFeeInHostCurrency: 550,
      hostFeeInHostCurrency: 550,
      paymentProcessorFeeInHostCurrency: 330,
      type: 'CREDIT',
      createdAt: '2015-05-29T07:00:00.000Z',
      PaymentMethodId: 1,
    };

    return Transaction.createFromContributionPayload(transactionPayload).then(() => {
      return Transaction.findAll().then(transactions => {
        expect(transactions.length).to.equal(4);

        const contributions = transactions.filter(t => t.kind === TransactionKind.CONTRIBUTION);

        expect(contributions.length).to.equal(2);
        expect(contributions[0] instanceof models.Transaction).to.be.true;
        expect(contributions[0].type).to.equal('DEBIT');
        expect(contributions[0].netAmountInCollectiveCurrency).to.equal(-10000);
        expect(contributions[0].currency).to.equal('EUR');
        expect(contributions[0].HostCollectiveId).to.be.null;
        expect(contributions[0].kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(contributions[0].description).to.equal(transactionPayload.description);

        expect(contributions[1].type).to.equal('CREDIT');
        expect(contributions[1].kind).to.equal(TransactionKind.CONTRIBUTION);
        expect(contributions[1].amount).to.equal(10000);
        expect(contributions[1].platformFeeInHostCurrency).to.equal(-550);
        expect(contributions[1].hostFeeInHostCurrency).to.equal(0);
        expect(contributions[1].paymentProcessorFeeInHostCurrency).to.equal(-330);
        expect(contributions[1].taxAmount).to.be.null;
        expect(contributions[1].amount).to.equal(10000);
        expect(contributions[1].netAmountInCollectiveCurrency).to.equal(9200);
      });
    });
  });

  it('createFromContributionPayload() generates a new activity', done => {
    const createActivityStub = stub(Transaction, 'createActivity').callsFake(t => {
      expect(Math.abs(t.amount)).to.equal(Math.abs(transactionsData[7].amount));
      createActivityStub.restore();
      done();
    });

    Transaction.createFromContributionPayload({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      ...transactionsData[7],
    })
      .then(transaction => {
        expect(transaction.CollectiveId).to.equal(collective.id);
      })
      .catch(done);
  });

  describe('fees on top', () => {
    it('should deduct the platform fee from the main transactions', async () => {
      const transactionPayload = {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        description: '$100 donation to Merveilles',
        amount: 11000,
        amountInHostCurrency: 11000,
        currency: 'USD',
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1,
        platformFeeInHostCurrency: 1000,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 300,
        type: 'CREDIT',
        createdAt: '2015-05-29T07:00:00.000Z',
        PaymentMethodId: 1,
        data: {
          isFeesOnTop: true,
        },
      };

      const t = await Transaction.createFromContributionPayload(transactionPayload);

      expect(t).to.have.property('platformFeeInHostCurrency').equal(0);
      expect(t).to.have.property('kind').equal(TransactionKind.CONTRIBUTION);
      expect(t)
        .to.have.property('netAmountInCollectiveCurrency')
        .equal(
          // The total amount of donation minus the fees on top
          10000 -
            // Minus the payment processor fee
            300,
        );
    });

    it('should create an additional pair of transactions between contributor and Open Collective Inc', async () => {
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
      });

      const transactionPayload = {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        description: '$100 donation to Merveilles',
        amount: 11000,
        totalAmount: 11000,
        amountInHostCurrency: 11000,
        currency: 'USD',
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1,
        platformFeeInHostCurrency: 1000,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: 'CREDIT',
        createdAt: '2015-05-29T07:00:00.000Z',
        PaymentMethodId: 1,
        OrderId: order.id,
        data: {
          isFeesOnTop: true,
        },
      };

      const createdTransaction = await Transaction.createFromContributionPayload(transactionPayload);

      // Should have 6 transactions:
      // - 2 for contributions
      // - 2 for platform tip (contributor -> Open Collective)
      // - 2 for platform tip debt (host -> Open Collective)
      const sqlOrder = [['createdAt', 'ASC']];
      const include = [{ association: 'host' }];
      const allTransactions = await Transaction.findAll({ where: { OrderId: order.id }, order: sqlOrder, include });
      await models.TransactionSettlement.attachStatusesToTransactions(allTransactions);
      expect(allTransactions).to.have.length(8);
      await utils.preloadAssociationsForTransactions(allTransactions, SNAPSHOT_COLUMNS_WITH_DEBT);
      utils.snapshotTransactions(allTransactions, { columns: SNAPSHOT_COLUMNS_WITH_DEBT });

      // Check base tip transactions
      const tipCredit = allTransactions.find(t => t.CollectiveId === inc.id && !t.isDebt);
      expect(tipCredit).to.have.property('type').equal('CREDIT');
      expect(tipCredit).to.have.property('amount').equal(1000);
      expect(tipCredit).to.have.property('kind').equal(TransactionKind.PLATFORM_TIP);
      expect(tipCredit).to.have.property('TransactionGroup').equal(createdTransaction.TransactionGroup);

      const tipDebit = allTransactions.find(t => t.FromCollectiveId === inc.id && !t.isDebt);
      expect(tipDebit).to.have.property('type').equal('DEBIT');
      expect(tipDebit).to.have.property('kind').equal(TransactionKind.PLATFORM_TIP);
      expect(tipDebit).to.have.property('TransactionGroup').equal(createdTransaction.TransactionGroup);
      expect(tipDebit).to.have.property('amount').equal(-1000);

      // Check tip DEBT transactions
      const tipDebtCredit = allTransactions.find(t => t.CollectiveId === inc.id && t.isDebt);
      const tipDebtDebit = allTransactions.find(t => t.CollectiveId === inc.id && t.isDebt);
      expect(tipDebtCredit).to.exist;
      expect(tipDebtDebit).to.exist;

      // Check settlement
      const settlement = await models.TransactionSettlement.getByTransaction(tipDebtCredit);
      expect(settlement).to.exist;
      expect(settlement.status).to.eq('OWED');
    });

    it('should convert the donation transaction to USD and store the FX rate', async () => {
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        currency: 'EUR',
      });

      const transactionPayload = {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        description: '$100 donation to Merveilles',
        amount: 11000,
        totalAmount: 11000,
        amountInHostCurrency: 11000,
        currency: 'EUR',
        hostCurrency: 'EUR',
        hostCurrencyFxRate: 1,
        platformFeeInHostCurrency: 1000,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: 'CREDIT',
        createdAt: '2015-05-29T07:00:00.000Z',
        PaymentMethodId: 1,
        OrderId: order.id,
        data: {
          isFeesOnTop: true,
        },
      };

      await Transaction.createFromContributionPayload(transactionPayload);

      const allTransactions = await Transaction.findAll({ where: { OrderId: order.id } });
      expect(allTransactions).to.have.length(8);

      const donationCredit = allTransactions.find(t => t.CollectiveId === inc.id);
      expect(donationCredit).to.have.property('type').equal('CREDIT');
      expect(donationCredit).to.have.property('currency').equal('EUR');
      expect(donationCredit).to.have.property('hostCurrency').equal('USD');
      expect(donationCredit).to.have.nested.property('data.hostToPlatformFxRate');
      expect(donationCredit).to.have.property('amount').equal(Math.round(1000));
      expect(donationCredit)
        .to.have.property('amountInHostCurrency')
        .equal(Math.round(1000 * donationCredit.data.hostToPlatformFxRate));

      const donationDebit = allTransactions.find(t => t.FromCollectiveId === inc.id);
      expect(donationDebit).to.have.nested.property('data.hostToPlatformFxRate');
      expect(donationDebit).to.have.property('type').equal('DEBIT');
      expect(donationDebit).to.have.property('currency').equal('EUR');
      expect(donationDebit).to.have.property('hostCurrency').equal('USD');
      expect(donationDebit).to.have.property('amount').equal(-1000);
      expect(donationDebit)
        .to.have.property('amountInHostCurrency')
        .equal(Math.round(-1000 * donationDebit.data.hostToPlatformFxRate));
    });

    it('should not create transactions if platformFee is 0', async () => {
      const order = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        currency: 'EUR',
      });

      const transactionPayload = {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        description: '$100 donation to Merveilles',
        amount: 10000,
        totalAmount: 10000,
        amountInHostCurrency: 10000,
        currency: 'EUR',
        hostCurrency: 'EUR',
        hostCurrencyFxRate: 1,
        platformFeeInHostCurrency: 0,
        hostFeeInHostCurrency: 500,
        paymentProcessorFeeInHostCurrency: 200,
        type: 'CREDIT',
        createdAt: '2015-05-29T07:00:00.000Z',
        PaymentMethodId: 1,
        OrderId: order.id,
        data: {
          isFeesOnTop: true,
        },
      };

      await Transaction.createFromContributionPayload(transactionPayload);

      const allTransactions = await Transaction.findAll({ where: { OrderId: order.id } });
      expect(allTransactions).to.have.length(4);
    });
  });

  it('should convert properly when using setCurrency', async () => {
    const order = await fakeOrder({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      currency: 'USD',
    });

    const transactionPayload = {
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      description: 'Financial contribution to Booky Foundation',
      amount: 500,
      currency: 'USD',
      amountInHostCurrency: 402,
      hostCurrency: 'EUR',
      hostCurrencyFxRate: 0.804,
      platformFeeInHostCurrency: 0,
      hostFeeInHostCurrency: 0,
      paymentProcessorFeeInHostCurrency: -31,
      type: 'CREDIT',
      PaymentMethodId: 1,
      OrderId: order.id,
      data: {
        charge: { currency: 'usd' },
        balanceTransaction: {
          currency: 'eur',
          exchange_rate: 0.803246, // eslint-disable-line camelcase
        },
      },
    };

    const credit = await Transaction.createFromContributionPayload(transactionPayload);

    await Transaction.validate(credit);

    await credit.setCurrency('EUR');

    await Transaction.validate(credit);

    expect(credit).to.have.property('currency').equal('EUR');

    expect(credit).to.have.property('amount').equal(402);
  });

  describe('createHostFeeShareTransactions', () => {
    it('applies different host fees share based on the payment method / host plan', async () => {
      await host.update({
        plan: 'default',
        hostFeePercent: 10,
        data: {
          plan: {
            hostFeeSharePercent: 20,
            creditCardHostFeeSharePercent: 0,
            paypalHostFeeSharePercent: 0,
          },
        },
      });

      const amount = 1000;

      // Helper to test with a given payment provider
      const testFeesWithPaymentMethod = async (service, type) => {
        const paymentMethod = await fakePaymentMethod({ service, type });
        const order = await fakeOrder({
          CollectiveId: collective.id,
          totalAmount: amount,
          PaymentMethodId: paymentMethod.id,
        });
        const transaction = await fakeTransaction({ OrderId: order.id, amount }, { createDoubleEntry: true });
        const hostFeeTransaction = { amountInHostCurrency: amount * 0.1, hostCurrency: host.currency };
        return Transaction.createHostFeeShareTransactions({ transaction, hostFeeTransaction }, host);
      };

      // Paypal payment
      let result = await testFeesWithPaymentMethod('paypal', 'payment');
      expect(result).to.be.undefined; // no host fee share

      // Stripe
      result = await testFeesWithPaymentMethod('stripe', 'creditcard');
      expect(result).to.be.undefined; // no host fee share

      // Manual
      result = await testFeesWithPaymentMethod('opencollective', 'manual');
      expect(result.hostFeeShareTransaction.amount).to.equal(Math.round(amount * 0.1 * 0.2));
      expect(result.hostFeeShareDebtTransaction.amount).to.equal(-Math.round(amount * 0.1 * 0.2));
    });
  });
});
