import express from 'express';
import { GraphQLFloat, GraphQLNonNull, GraphQLString } from 'graphql';
import { isNil } from 'lodash';

import { addFunds } from '../../common/orders';
import { ValidationFailed } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { AmountInput, getValueInCentsFromAmountInput } from '../input/AmountInput';
import { fetchTierWithReference, TierReferenceInput } from '../input/TierReferenceInput';
import { Order } from '../object/Order';

export const addFundsMutation = {
  type: new GraphQLNonNull(Order),
  description: 'Add funds to the given account',
  args: {
    fromAccount: { type: new GraphQLNonNull(AccountReferenceInput) },
    account: { type: new GraphQLNonNull(AccountReferenceInput) },
    tier: { type: TierReferenceInput },
    amount: { type: new GraphQLNonNull(AmountInput) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    hostFeePercent: { type: GraphQLFloat },
  },
  resolve: async (_, args, req: express.Request): Promise<Record<string, unknown>> => {
    const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
    const fromAccount = await fetchAccountWithReference(args.fromAccount, { throwIfMissing: true });
    const tier = args.tier && (await fetchTierWithReference(args.tier, { throwIfMissing: true }));

    const allowedTypes = ['ORGANIZATION', 'COLLECTIVE', 'EVENT', 'FUND', 'PROJECT'];
    if (!allowedTypes.includes(account.type)) {
      throw new ValidationFailed(`Adding funds is only possible for the following types: ${allowedTypes.join(',')}`);
    }

    if (!isNil(args.hostFeePercent)) {
      if (args.hostFeePercent < 0 || args.hostFeePercent > 100) {
        throw new ValidationFailed('hostFeePercent should be a value between 0 and 100.');
      }
    }

    return addFunds(
      {
        totalAmount: getValueInCentsFromAmountInput(args.amount),
        collective: account,
        fromCollective: fromAccount,
        description: args.description,
        hostFeePercent: args.hostFeePercent,
        tier,
      },
      req.remoteUser,
    );
  },
};
