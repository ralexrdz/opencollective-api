/* eslint-disable camelcase */
import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

import { activities, frequencies, providers } from '../../../constants';
import logger from '../../../lib/logger';
import models from '../../../models';
import VirtualCardModel from '../../../models/VirtualCard';
import privacy from '../../../paymentProviders/privacy';
import * as stripe from '../../../paymentProviders/stripe/virtual-cards';
import { BadRequest, NotFound, Unauthorized } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { AmountInput } from '../input/AmountInput';
import { VirtualCardInput } from '../input/VirtualCardInput';
import { VirtualCardReferenceInput } from '../input/VirtualCardReferenceInput';
import { VirtualCard } from '../object/VirtualCard';

const MAXIMUM_MONTHLY_LIMIT = 2000;

const virtualCardMutations = {
  assignNewVirtualCard: {
    description: 'Assign Virtual Card information to existing hosted collective',
    type: new GraphQLNonNull(VirtualCard),
    args: {
      virtualCard: {
        type: new GraphQLNonNull(VirtualCardInput),
        description: 'Virtual Card data',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the virtual card will be associated',
      },
      assignee: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Individual account responsible for the card',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to assign a virtual card');
      }

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      const host = await collective.getHostCollective();
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized("You don't have permission to edit this collective");
      }

      const assignee = await fetchAccountWithReference(args.assignee, {
        loaders: req.loaders,
        throwIfMissing: true,
      });
      const user = await assignee.getUser();
      if (!user) {
        throw new BadRequest('Could not find the assigned user');
      }

      const { cardNumber, expireDate, cvv } = args.virtualCard.privateData;

      if (!cardNumber || !expireDate || !cvv) {
        throw new BadRequest('VirtualCard missing cardNumber, expireDate and/or cvv', undefined, {
          cardNumber: !cardNumber && 'Card Number is required',
          expireDate: !expireDate && 'Expire Date is required',
          cvv: !cvv && 'CVV is required',
        });
      }

      const providerService = args.virtualCard.provider === providers.STRIPE ? stripe : privacy;

      const virtualCard = await providerService.assignCardToCollective(
        cardNumber,
        expireDate,
        cvv,
        args.virtualCard.name,
        collective.id,
        host,
        user.id,
      );

      await models.Activity.create({
        type: activities.COLLECTIVE_VIRTUAL_CARD_ADDED,
        UserId: req.remoteUser.id,
        CollectiveId: collective.id,
        data: {
          assignee: assignee.activity,
          collective: collective.activity,
          host: host.activity,
        },
      }).catch(e => logger.error('An error occured when creating the COLLECTIVE_VIRTUAL_CARD_ADDED activity', e));

      return virtualCard;
    },
  },
  createVirtualCard: {
    description: 'Create new Stripe Virtual Card for existing hosted collective',
    type: new GraphQLNonNull(VirtualCard),
    args: {
      name: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'Virtual card name',
      },
      monthlyLimit: {
        type: new GraphQLNonNull(AmountInput),
        description: 'Virtual card monthly limit',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the virtual card will be associated',
      },
      assignee: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Individual account responsible for the virtual card',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to create a virtual card');
      }

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      const host = await collective.getHostCollective();

      const monthlyLimitInCents = args.monthlyLimit.valueInCents;

      if (monthlyLimitInCents > MAXIMUM_MONTHLY_LIMIT * 100) {
        throw new BadRequest(`Monthly limit should not exceed ${MAXIMUM_MONTHLY_LIMIT} ${host.currency}`, undefined, {
          monthlyLimit: `Monthly limit should not exceed ${MAXIMUM_MONTHLY_LIMIT} ${host.currency}`,
        });
      }

      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Unauthorized("You don't have permission to edit this collective");
      }

      const assignee = await fetchAccountWithReference(args.assignee, {
        loaders: req.loaders,
        throwIfMissing: true,
      });

      const user = await assignee.getUser();

      if (!user) {
        throw new BadRequest('Could not find the assigned user');
      }

      const virtualCard = await stripe.createVirtualCard(host, collective, user.id, args.name, monthlyLimitInCents);

      await models.Activity.create({
        type: activities.COLLECTIVE_VIRTUAL_CARD_ADDED,
        UserId: req.remoteUser.id,
        CollectiveId: collective.id,
        data: {
          assignee: assignee.activity,
          collective: collective.activity,
          host: host.activity,
        },
      }).catch(e => logger.error('An error occured when creating the COLLECTIVE_VIRTUAL_CARD_ADDED activity', e));

      return virtualCard;
    },
  },
  editVirtualCard: {
    description: 'Edit existing Virtual Card information',
    type: new GraphQLNonNull(VirtualCard),
    args: {
      virtualCard: {
        type: new GraphQLNonNull(VirtualCardReferenceInput),
        description: 'Virtual card reference',
      },
      name: {
        type: GraphQLString,
        description: 'Virtual card name',
      },
      assignee: {
        type: AccountReferenceInput,
        description: 'Individual account responsible for the card',
      },
      monthlyLimit: {
        type: AmountInput,
        description: 'Virtual card monthly limit',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to assign a virtual card');
      }

      const virtualCard = await models.VirtualCard.findOne({
        where: { id: args.virtualCard.id },
        include: [{ association: 'host', required: true }],
      });
      if (!virtualCard) {
        throw new NotFound('Could not find Virtual Card');
      }
      if (!req.remoteUser.isAdmin(virtualCard.HostCollectiveId)) {
        throw new Unauthorized("You don't have permission to update this Virtual Card");
      }

      const updateAttributes = {};

      if (args.assignee) {
        const userCollective = await fetchAccountWithReference(args.assignee, {
          loaders: req.loaders,
        });

        const user = await userCollective.getUser();

        if (!user) {
          throw new BadRequest('Could not find the assigned user');
        }

        updateAttributes['UserId'] = user.id;
      }

      if (args.name) {
        updateAttributes['name'] = args.name;
      }

      if (
        args.monthlyLimit &&
        virtualCard.spendingLimitInterval === frequencies.MONTHLY &&
        virtualCard.provider === providers.STRIPE
      ) {
        const monthlyLimitInCents = args.monthlyLimit.valueInCents;

        if (monthlyLimitInCents > MAXIMUM_MONTHLY_LIMIT * 100) {
          throw new BadRequest(
            `Monthly limit should not exceed ${MAXIMUM_MONTHLY_LIMIT} ${virtualCard.currency}`,
            undefined,
            {
              monthlyLimit: `Monthly limit should not exceed ${MAXIMUM_MONTHLY_LIMIT} ${virtualCard.currency}`,
            },
          );
        }

        updateAttributes['spendingLimitAmount'] = monthlyLimitInCents;

        await stripe.updateVirtualCardMonthlyLimit(virtualCard, monthlyLimitInCents);
      }

      return virtualCard.update(updateAttributes);
    },
  },
  requestVirtualCard: {
    description: 'Request Virtual Card to host',
    type: GraphQLBoolean,
    args: {
      notes: {
        type: GraphQLString,
        description: 'Request notes',
      },
      purpose: {
        type: GraphQLString,
        description: 'Purpose for this Virtual Card',
      },
      budget: {
        type: GraphQLInt,
        description: 'Monthly budget you want for this Virtual Card',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the virtual card will be associated',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<boolean> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to request a virtual card');
      }
      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized("You don't have permission to request a virtual card for this collective");
      }

      const host = await collective.getHostCollective();
      const userCollective = await req.remoteUser.getCollective();
      const activity = {
        type: activities.VIRTUAL_CARD_REQUESTED,
        UserId: req.remoteUser.id,
        data: {
          host: host.activity,
          collective: { ...collective.activity, path: await collective.getUrlPath() },
          userCollective: userCollective.activity,
          user: req.remoteUser.minimal,
          notes: args.notes,
          budget: args.budget,
          purpose: args.purpose,
        },
      };

      await models.Activity.create(activity);

      return true;
    },
  },
  pauseVirtualCard: {
    description: 'Pause active Virtual Card',
    type: new GraphQLNonNull(VirtualCard),
    args: {
      virtualCard: {
        type: new GraphQLNonNull(VirtualCardReferenceInput),
        description: 'Virtual Card reference',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to assign a Virtual Card');
      }

      const virtualCard = await models.VirtualCard.findOne({
        where: { id: args.virtualCard.id },
        include: [
          {
            model: models.Collective,
            as: 'collective',
          },
          {
            model: models.Collective,
            as: 'host',
          },
        ],
      });
      if (!virtualCard) {
        throw new NotFound('Could not find Virtual Card');
      }

      if (!req.remoteUser.isAdmin(virtualCard.HostCollectiveId)) {
        throw new Unauthorized("You don't have permission to edit this Virtual Card");
      }

      const card = await virtualCard.pause();
      const data = {
        virtualCard,
        host: virtualCard.host.info,
        collective: virtualCard.collective.info,
      };
      await models.Activity.create({
        type: activities.COLLECTIVE_VIRTUAL_CARD_SUSPENDED,
        CollectiveId: virtualCard.collective.id,
        data,
      });

      return card;
    },
  },
  resumeVirtualCard: {
    description: 'Resume paused Virtual Card',
    type: new GraphQLNonNull(VirtualCard),
    args: {
      virtualCard: {
        type: new GraphQLNonNull(VirtualCardReferenceInput),
        description: 'Virtual Card reference',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<VirtualCardModel> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to assign a Virtual Card');
      }

      const virtualCard = await models.VirtualCard.findOne({ where: { id: args.virtualCard.id } });
      if (!virtualCard) {
        throw new NotFound('Could not find Virtual Card');
      }

      if (!req.remoteUser.isAdmin(virtualCard.HostCollectiveId)) {
        throw new Unauthorized("You don't have permission to edit this Virtual Card");
      }

      return virtualCard.resume();
    },
  },
  deleteVirtualCard: {
    description: 'Delete Virtual Card',
    type: GraphQLBoolean,
    args: {
      virtualCard: {
        type: new GraphQLNonNull(VirtualCardReferenceInput),
        description: 'Virtual Card reference',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<boolean> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to assign a Virtual Card');
      }

      const virtualCard = await models.VirtualCard.findOne({ where: { id: args.virtualCard.id } });
      if (!virtualCard) {
        throw new NotFound('Could not find Virtual Card');
      }

      if (!req.remoteUser.isAdmin(virtualCard.HostCollectiveId)) {
        throw new Unauthorized("You don't have permission to edit this Virtual Card");
      }
      await virtualCard.delete();
      return true;
    },
  },
};

export default virtualCardMutations;
