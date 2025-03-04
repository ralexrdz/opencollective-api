import * as LibTaxes from '@opencollective/taxes';
import debugLib from 'debug';
import express from 'express';
import { cloneDeep, flatten, get, isEqual, isNil, omitBy, pick, set, size, sumBy } from 'lodash';

import { activities, expenseStatus, roles } from '../../constants';
import { types as collectiveTypes } from '../../constants/collectives';
import statuses from '../../constants/expense_status';
import EXPENSE_TYPE from '../../constants/expense_type';
import { ExpenseFeesPayer } from '../../constants/expense-fees-payer';
import FEATURE from '../../constants/feature';
import { EXPENSE_PERMISSION_ERROR_CODES } from '../../constants/permissions';
import POLICIES from '../../constants/policies';
import { TransactionKind } from '../../constants/transaction-kind';
import { hasFeature } from '../../lib/allowed-features';
import { getFxRate } from '../../lib/currency';
import errors from '../../lib/errors';
import logger from '../../lib/logger';
import { floatAmountToCents } from '../../lib/math';
import * as libPayments from '../../lib/payments';
import { notifyTeamAboutSpamExpense } from '../../lib/spam';
import { createTransactionsFromPaidExpense } from '../../lib/transactions';
import {
  handleTwoFactorAuthenticationPayoutLimit,
  resetRollingPayoutLimitOnFailure,
} from '../../lib/two-factor-authentication';
import { canUseFeature } from '../../lib/user-permissions';
import { formatCurrency } from '../../lib/utils';
import models, { sequelize } from '../../models';
import { ExpenseAttachedFile } from '../../models/ExpenseAttachedFile';
import { ExpenseItem } from '../../models/ExpenseItem';
import { PayoutMethodTypes } from '../../models/PayoutMethod';
import paymentProviders from '../../paymentProviders';
import {
  Quote as WiseQuote,
  QuoteV2 as WiseQuoteV2,
  RecipientAccount as BankAccountPayoutMethodData,
  Transfer as WiseTransfer,
} from '../../types/transferwise';
import {
  BadRequest,
  FeatureNotAllowedForUser,
  FeatureNotSupportedForCollective,
  Forbidden,
  NotFound,
  Unauthorized,
  ValidationFailed,
} from '../errors';
import { CurrencyExchangeRateSourceTypeEnum } from '../v2/enum/CurrencyExchangeRateSourceType';

const debug = debugLib('expenses');

const isOwner = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  } else if (req.remoteUser.id === expense.UserId) {
    return true;
  } else if (!expense.fromCollective) {
    expense.fromCollective = await req.loaders.Collective.byId.load(expense.FromCollectiveId);
    if (!expense.fromCollective) {
      return false;
    }
  }

  return req.remoteUser.isAdminOfCollective(expense.fromCollective);
};

const isCollectiveAccountant = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  } else if (req.remoteUser.hasRole(roles.ACCOUNTANT, expense.CollectiveId)) {
    return true;
  }

  const collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
  if (!collective) {
    return false;
  } else if (req.remoteUser.hasRole(roles.ACCOUNTANT, collective.HostCollectiveId)) {
    return true;
  } else if (collective.ParentCollectiveId) {
    return req.remoteUser.hasRole(roles.ACCOUNTANT, collective.ParentCollectiveId);
  } else {
    return false;
  }
};

const isCollectiveAdmin = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  if (!expense.collective) {
    expense.collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
  }

  return req.remoteUser.isAdminOfCollective(expense.collective);
};

const isHostAdmin = async (req: express.Request, expense: typeof models.Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  if (!expense.collective) {
    expense.collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
  }

  if (!expense.collective) {
    return false;
  }

  return req.remoteUser.isAdmin(expense.collective.HostCollectiveId) && expense.collective.isActive;
};

export type ExpensePermissionEvaluator = (
  req: express.Request,
  expense: typeof models.Expense,
  options?: { throw?: boolean },
) => Promise<boolean>;

/**
 * Returns true if the expense meets at least one condition.
 * Always returns false for unauthenticated requests.
 */
const remoteUserMeetsOneCondition = async (
  req: express.Request,
  expense: typeof models.Expense,
  conditions: ExpensePermissionEvaluator[],
  options: { throw?: boolean } = { throw: false },
): Promise<boolean> => {
  if (!req.remoteUser) {
    if (options?.throw) {
      throw new Unauthorized('User is required', EXPENSE_PERMISSION_ERROR_CODES.MINIMAL_CONDITION_NOT_MET);
    }
    return false;
  }

  for (const condition of conditions) {
    if (await condition(req, expense)) {
      return true;
    }
  }

  if (options?.throw) {
    throw new Unauthorized(
      'User does not meet minimal condition',
      EXPENSE_PERMISSION_ERROR_CODES.MINIMAL_CONDITION_NOT_MET,
    );
  }
  return false;
};

/** Checks if the user can see expense's attachments (items URLs, attached files) */
export const canSeeExpenseAttachments: ExpensePermissionEvaluator = async (req, expense) => {
  return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isCollectiveAccountant, isHostAdmin]);
};

/** Checks if the user can see expense's payout method */
export const canSeeExpensePayoutMethod: ExpensePermissionEvaluator = async (req, expense) => {
  return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isCollectiveAccountant, isHostAdmin]);
};

/** Checks if the user can see expense's payout method */
export const canSeeExpenseInvoiceInfo: ExpensePermissionEvaluator = async (
  req,
  expense,
  options = { throw: false },
) => {
  return remoteUserMeetsOneCondition(
    req,
    expense,
    [isOwner, isCollectiveAdmin, isCollectiveAccountant, isHostAdmin],
    options,
  );
};

/** Checks if the user can see expense's payout method */
export const canSeeExpensePayeeLocation: ExpensePermissionEvaluator = async (req, expense) => {
  return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isCollectiveAccountant, isHostAdmin]);
};

/** Checks if the user can verify or resend a draft */
export const canVerifyDraftExpense: ExpensePermissionEvaluator = async (req, expense) => {
  return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isHostAdmin]);
};

/**
 * Returns the list of items for this expense.
 */
export const getExpenseItems = async (expenseId: number, req: express.Request): Promise<ExpenseItem[]> => {
  return req.loaders.Expense.items.load(expenseId);
};

/**
 * Only admin of expense.collective or of expense.collective.host can approve/reject expenses
 * @deprecated: Please use more specific helpers like `canEdit`, `canDelete`, etc.
 */
export const canUpdateExpenseStatus: ExpensePermissionEvaluator = async (req, expense) => {
  const { remoteUser } = req;
  if (!remoteUser) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    return false;
  } else if (remoteUser.hasRole([roles.ADMIN], expense.CollectiveId)) {
    return true;
  } else {
    if (!expense.collective) {
      expense.collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
    }

    return remoteUser.isAdmin(expense.collective.HostCollectiveId);
  }
};

/**
 * Only the author or an admin of the collective or collective.host can edit an expense when it hasn't been paid yet
 */
export const canEditExpense: ExpensePermissionEvaluator = async (req, expense, options = { throw: false }) => {
  const nonEditableStatuses = [
    expenseStatus.PAID,
    expenseStatus.PROCESSING,
    expenseStatus.DRAFT,
    expenseStatus.SCHEDULED_FOR_PAYMENT,
    expenseStatus.CANCELED,
  ];

  // Collective Admin can attach receipts to paid charge expenses
  if (
    expense.type === EXPENSE_TYPE.CHARGE &&
    expense.status === expenseStatus.PAID &&
    req.remoteUser?.hasRole([roles.ADMIN], expense.CollectiveId)
  ) {
    return true;
  } else if (nonEditableStatuses.includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden('Can not edit expense in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot edit expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isCollectiveAdmin], options);
  }
};

export const canEditExpenseTags: ExpensePermissionEvaluator = async (req, expense, options = { throw: false }) => {
  if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot edit expense tags', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (expense.status === expenseStatus.PAID) {
    // Only collective/host admins can edit tags after the expense is paid
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin, isCollectiveAdmin], options);
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isCollectiveAdmin], options);
  }
};

/**
 * Only the author or an admin of the collective or collective.host can delete an expense,
 * and only when its status is REJECTED.
 */
export const canDeleteExpense: ExpensePermissionEvaluator = async (req, expense, options = { throw: false }) => {
  if (
    ![expenseStatus.REJECTED, expenseStatus.DRAFT, expenseStatus.SPAM, expenseStatus.CANCELED].includes(expense.status)
  ) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not delete expense in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot delete expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be paid by user
 */
export const canPayExpense: ExpensePermissionEvaluator = async (req, expense, options = { throw: false }) => {
  if (![expenseStatus.APPROVED, expenseStatus.ERROR].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden('Can not pay expense in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot pay expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be approved by user
 */
export const canApprove: ExpensePermissionEvaluator = async (req, expense, options = { throw: false }) => {
  if (![expenseStatus.PENDING, expenseStatus.REJECTED].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not approve expense in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot approve expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    expense.collective = expense.collective || (await req.loaders.Collective.byId.load(expense.CollectiveId));
    if (expense.collective.hasPolicy(POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE) && req.remoteUser.id === expense.UserId) {
      if (options?.throw) {
        throw new Forbidden(
          'User cannot approve their own expenses',
          EXPENSE_PERMISSION_ERROR_CODES.AUTHOR_CANNOT_APPROVE,
        );
      }
      return false;
    }
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be rejected by user
 */
export const canReject: ExpensePermissionEvaluator = async (req, expense, options = { throw: false }) => {
  if (![expenseStatus.PENDING, expenseStatus.UNVERIFIED].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not reject expense in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot reject expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be rejected by user
 */
export const canMarkAsSpam: ExpensePermissionEvaluator = async (req, expense, options = { throw: false }) => {
  if (![expenseStatus.REJECTED].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not mark expense as spam in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot mark expenses as spam', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be unapproved by user
 */
export const canUnapprove: ExpensePermissionEvaluator = async (req, expense, options = { throw: false }) => {
  if (![expenseStatus.APPROVED, expenseStatus.ERROR].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not unapprove expense in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot unapprove expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be marked as unpaid by user
 */
export const canMarkAsUnpaid: ExpensePermissionEvaluator = async (req, expense, options = { throw: false }) => {
  if (expense.status !== expenseStatus.PAID) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not mark expense as unpaid in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden(
        'User cannot mark expenses as unpaid',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE,
      );
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
  }
};

/**
 * Returns true if user can comment and see others comments for this expense
 */
export const canComment: ExpensePermissionEvaluator = async (req, expense, options = { throw: false }) => {
  if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot pay expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin, isOwner], options);
  }
};

export const canViewRequiredLegalDocuments: ExpensePermissionEvaluator = async (req, expense) => {
  return remoteUserMeetsOneCondition(req, expense, [isHostAdmin, isCollectiveAdmin, isCollectiveAccountant, isOwner]);
};

export const canUnschedulePayment: ExpensePermissionEvaluator = async (req, expense, options = { throw: false }) => {
  if (expense.status !== expenseStatus.SCHEDULED_FOR_PAYMENT) {
    if (options?.throw) {
      throw new Forbidden('Can not pay expense in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
    }
    return false;
  }
  return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
};

// ---- Expense actions ----

export const approveExpense = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<typeof models.Expense> => {
  if (expense.status === expenseStatus.APPROVED) {
    return expense;
  } else if (!(await canApprove(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: expenseStatus.APPROVED, lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_APPROVED, req.remoteUser);
  return updatedExpense;
};

export const unapproveExpense = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<typeof models.Expense> => {
  if (expense.status === expenseStatus.PENDING) {
    return expense;
  } else if (!(await canUnapprove(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: expenseStatus.PENDING, lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_UNAPPROVED, req.remoteUser);
  return updatedExpense;
};

export const rejectExpense = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<typeof models.Expense> => {
  if (expense.status === expenseStatus.REJECTED) {
    return expense;
  } else if (!(await canReject(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: expenseStatus.REJECTED, lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_REJECTED, req.remoteUser);
  return updatedExpense;
};

export const markExpenseAsSpam = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<typeof models.Expense> => {
  if (expense.status === expenseStatus.SPAM) {
    return expense;
  } else if (!(await canMarkAsSpam(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: expenseStatus.SPAM, lastEditedById: req.remoteUser.id });

  // Limit the user so they can't submit expenses in the future
  const submittedByUser = await updatedExpense.getSubmitterUser();
  await submittedByUser.limitFeature(FEATURE.USE_EXPENSES);

  // Cancel recurring expense
  const recurringExpense = await expense.getRecurringExpense();
  if (recurringExpense) {
    await recurringExpense.destroy();
  }

  // We create the activity as a good practice but there is no email sent right now
  const activity = await expense.createActivity(activities.COLLECTIVE_EXPENSE_MARKED_AS_SPAM, req.remoteUser);

  // For now, we send the Slack notification directly from here as there is no framework in activities/notifications
  notifyTeamAboutSpamExpense(activity);

  return updatedExpense;
};

export const scheduleExpenseForPayment = async (
  req: express.Request,
  expense: typeof models.Expense,
  feesPayer: 'COLLECTIVE' | 'PAYEE',
): Promise<typeof models.Expense> => {
  if (expense.status === expenseStatus.SCHEDULED_FOR_PAYMENT) {
    throw new BadRequest('Expense is already scheduled for payment');
  } else if (!(await canPayExpense(req, expense))) {
    throw new Forbidden("You're authenticated but you can't schedule this expense for payment");
  }

  const host = await expense.collective.getHostCollective();
  if (expense.currency !== expense.collective.currency && !hasMultiCurrency(expense.collective, host)) {
    throw new Unauthorized('Multi-currency expenses are not enabled for this collective');
  }

  const payoutMethod = await expense.getPayoutMethod();
  await checkHasBalanceToPayExpense(host, expense, payoutMethod);

  if (feesPayer && feesPayer !== expense.feesPayer) {
    await expense.update({ feesPayer: feesPayer });
  }

  // If Wise, add expense to a new batch group
  if (payoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
    await paymentProviders.transferwise.scheduleExpenseForPayment(expense);
  }
  // If PayPal, check if host is connected to PayPal
  else if (payoutMethod.type === PayoutMethodTypes.PAYPAL) {
    await host.getAccountForPaymentProvider('paypal');
  }

  const updatedExpense = await expense.update({
    status: expenseStatus.SCHEDULED_FOR_PAYMENT,
    lastEditedById: req.remoteUser.id,
  });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT, req.remoteUser);
  return updatedExpense;
};

export const unscheduleExpensePayment = async (
  req: express.Request,
  expense: typeof models.Expense,
): Promise<typeof models.Expense> => {
  if (!(await canUnschedulePayment(req, expense))) {
    throw new BadRequest("Expense is not scheduled for payment or you don't have authorization to unschedule it");
  }

  // If Wise, add expense to a new batch group
  const payoutMethod = await expense.getPayoutMethod();
  if (payoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
    await paymentProviders.transferwise.unscheduleExpenseForPayment(expense);
  }

  const updatedExpense = await expense.update({
    status: expenseStatus.APPROVED,
    lastEditedById: req.remoteUser.id,
  });
  return updatedExpense;
};

/** Compute the total amount of expense from expense items */
const computeTotalAmountForExpense = (items: Record<string, unknown>[], taxes: TaxDefinition[]) => {
  return Math.round(
    sumBy(items, item => {
      const totalTaxes = sumBy(taxes, tax => <number>item['amount'] * tax.rate);
      return <number>item['amount'] + totalTaxes;
    }),
  );
};

/** Check expense's items values, throw if something's wrong */
const checkExpenseItems = (expenseData, items, taxes) => {
  // Check the number of items
  if (!items || items.length === 0) {
    throw new ValidationFailed('Your expense needs to have at least one item');
  } else if (items.length > 300) {
    throw new ValidationFailed('Expenses cannot have more than 300 items');
  }

  // Check amounts
  const sumItems = computeTotalAmountForExpense(items, taxes);
  if (!sumItems) {
    throw new ValidationFailed(`The sum of all items must be above 0`);
  }

  // If expense is a receipt (not an invoice) then files must be attached
  if (expenseData.type === EXPENSE_TYPE.RECEIPT) {
    const hasMissingFiles = items.some(a => !a.url);
    if (hasMissingFiles) {
      throw new ValidationFailed('Some items are missing a file');
    }
  }
};

const EXPENSE_EDITABLE_FIELDS = [
  'amount',
  'currency',
  'description',
  'longDescription',
  'type',
  'tags',
  'privateMessage',
  'invoiceInfo',
  'payeeLocation',
];

const EXPENSE_PAID_CHARGE_EDITABLE_FIELDS = ['description', 'tags', 'privateMessage', 'invoiceInfo'];

const getPayoutMethodFromExpenseData = async (expenseData, remoteUser, fromCollective, dbTransaction) => {
  if (expenseData.payoutMethod) {
    if (expenseData.payoutMethod.id) {
      const pm = await models.PayoutMethod.findByPk(expenseData.payoutMethod.id);
      if (!pm) {
        throw new Error('This payout method does not exist.');
      }
      // Special case: Payout Method from the Host for "Expense Accross Hosts"
      // No need for extra checks
      if (
        pm.CollectiveId === fromCollective.HostCollectiveId &&
        [PayoutMethodTypes.BANK_ACCOUNT, PayoutMethodTypes.PAYPAL].includes(pm.type)
      ) {
        return pm;
      }
      if (!remoteUser.isAdmin(pm.CollectiveId)) {
        throw new Error("You don't have the permission to use this payout method.");
      }
      if (pm.CollectiveId !== fromCollective.id) {
        throw new Error('This payout method cannot be used for this collective');
      }
      return pm;
    } else {
      return models.PayoutMethod.getOrCreateFromData(
        expenseData.payoutMethod,
        remoteUser,
        fromCollective,
        dbTransaction,
      );
    }
  } else {
    return null;
  }
};

/** Creates attached files for the given expense */
const createAttachedFiles = async (expense, attachedFilesData, remoteUser, transaction) => {
  if (size(attachedFilesData) > 0) {
    return Promise.all(
      attachedFilesData.map(attachedFile => {
        return models.ExpenseAttachedFile.createFromData(attachedFile.url, remoteUser, expense, transaction);
      }),
    );
  } else {
    return [];
  }
};

const hasMultiCurrency = (collective, host) => {
  if (collective.currency !== host?.currency) {
    return false; // Only support multi-currency when collective/host have the same currency
  } else {
    return hasFeature(collective, FEATURE.MULTI_CURRENCY_EXPENSES) || hasFeature(host, FEATURE.MULTI_CURRENCY_EXPENSES);
  }
};

type TaxDefinition = {
  type: string;
  rate: number;
  idNumber: string;
};

type ExpenseData = {
  id?: number;
  payoutMethod?: Record<string, unknown>;
  payeeLocation?: Record<string, unknown>;
  items?: Record<string, unknown>[];
  attachedFiles?: Record<string, unknown>[];
  collective?: Record<string, unknown>;
  fromCollective?: Record<string, unknown>;
  tags?: string[];
  incurredAt?: Date;
  type?: string;
  description?: string;
  currency?: string;
  tax?: TaxDefinition[];
};

const checkTaxes = (account, host, expenseType: string, taxes): void => {
  if (!taxes?.length) {
    return;
  } else if (taxes.length > 1) {
    throw new ValidationFailed('Only one tax is allowed per expense');
  } else if (expenseType !== EXPENSE_TYPE.INVOICE) {
    throw new ValidationFailed('Only invoices can have taxes');
  } else {
    return taxes.forEach(({ type, rate }) => {
      if (rate < 0 || rate > 1) {
        throw new ValidationFailed(`Tax rate for ${type} must be between 0% and 100%`);
      } else if (type === LibTaxes.TaxType.VAT && !LibTaxes.accountHasVAT(account)) {
        throw new ValidationFailed(`This account does not have VAT enabled`);
      } else if (type === LibTaxes.TaxType.GST && !LibTaxes.accountHasGST(host)) {
        throw new ValidationFailed(`This host does not have GST enabled`);
      }
    });
  }
};

export async function createExpense(
  remoteUser: typeof models.User | null,
  expenseData: ExpenseData,
): Promise<typeof models.Expense> {
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to create an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  if (!get(expenseData, 'collective.id')) {
    throw new Unauthorized('Missing expense.collective.id');
  }

  const collective = await models.Collective.findByPk(expenseData.collective.id, {
    include: [{ association: 'host', required: false }],
  });
  if (!collective) {
    throw new ValidationFailed('Collective not found');
  }

  const isMember = Boolean(remoteUser.rolesByCollectiveId[String(collective.id)]);
  if (
    expenseData.collective.settings?.['disablePublicExpenseSubmission'] &&
    !isMember &&
    !remoteUser.isAdminOfCollectiveOrHost(collective) &&
    !remoteUser.isRoot()
  ) {
    throw new Error('You must be a member of the collective to create new expense');
  }

  const itemsData = expenseData.items;
  const taxes = expenseData.tax || [];

  checkTaxes(collective, collective.host, expenseData.type, taxes);
  checkExpenseItems(expenseData, itemsData, taxes);

  if (size(expenseData.attachedFiles) > 15) {
    throw new ValidationFailed('The number of files that you can attach to an expense is limited to 15');
  }

  const isAllowedType = [
    collectiveTypes.COLLECTIVE,
    collectiveTypes.EVENT,
    collectiveTypes.FUND,
    collectiveTypes.PROJECT,
  ].includes(collective.type);
  const isActiveHost = collective.type === collectiveTypes.ORGANIZATION && collective.isActive;
  if (!isAllowedType && !isActiveHost) {
    throw new ValidationFailed(
      'Expenses can only be submitted to Collectives, Events, Funds, Projects and active Hosts.',
    );
  }

  // Let submitter customize the currency
  let currency = collective.currency;
  if (expenseData.currency && expenseData.currency !== currency) {
    if (!hasMultiCurrency(collective, collective.host)) {
      throw new FeatureNotSupportedForCollective('Multi-currency expenses are not enabled for this account');
    } else {
      currency = expenseData.currency;
    }
  }

  // Load the payee profile
  const fromCollective = expenseData.fromCollective || (await remoteUser.getCollective());
  if (!remoteUser.isAdminOfCollective(fromCollective)) {
    throw new ValidationFailed('You must be an admin of the account to submit an expense in its name');
  } else if (!fromCollective.canBeUsedAsPayoutProfile()) {
    throw new ValidationFailed('This account cannot be used for payouts');
  }

  // Update payee's location
  if (!expenseData.payeeLocation?.address && fromCollective.location) {
    expenseData.payeeLocation = pick(fromCollective.location, ['address', 'country', 'structured']);
  } else if (
    expenseData.payeeLocation?.address &&
    (!fromCollective.location.address || !fromCollective.location.structured)
  ) {
    // Let's take the opportunity to update collective's location
    await fromCollective.update({
      address: expenseData.payeeLocation.address,
      countryISO: expenseData.payeeLocation.country,
      data: { ...fromCollective.data, address: expenseData.payeeLocation.structured },
    });
  }

  // Get or create payout method
  const payoutMethod = await getPayoutMethodFromExpenseData(expenseData, remoteUser, fromCollective, null);

  // Create and validate TransferWise recipient
  let recipient;
  if (payoutMethod?.type === PayoutMethodTypes.BANK_ACCOUNT) {
    const payoutMethodData = <BankAccountPayoutMethodData>payoutMethod.data;
    const accountHolderName = payoutMethodData?.accountHolderName;
    const legalName = <string>expenseData.fromCollective.legalName;
    if (accountHolderName && legalName && !isAccountHolderNameAndLegalNameMatch(accountHolderName, legalName)) {
      logger.warn('The legal name should match the bank account holder name (${accountHolderName} ≠ ${legalName})');
    }

    const connectedAccounts =
      collective.host && (await collective.host.getConnectedAccounts({ where: { service: 'transferwise' } }));
    if (connectedAccounts?.[0]) {
      paymentProviders.transferwise.validatePayoutMethod(connectedAccounts[0], payoutMethod);
      recipient = await paymentProviders.transferwise.createRecipient(connectedAccounts[0], payoutMethod);
    }
  }

  const expense = await sequelize.transaction(async t => {
    // Create expense
    const createdExpense = await models.Expense.create(
      {
        ...pick(expenseData, EXPENSE_EDITABLE_FIELDS),
        currency,
        tags: expenseData.tags,
        status: statuses.PENDING,
        CollectiveId: collective.id,
        FromCollectiveId: fromCollective.id,
        lastEditedById: remoteUser.id,
        UserId: remoteUser.id,
        incurredAt: expenseData.incurredAt || new Date(),
        PayoutMethodId: payoutMethod && payoutMethod.id,
        legacyPayoutMethod: models.Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
        amount: computeTotalAmountForExpense(itemsData, taxes),
        data: { recipient, taxes },
      },
      { transaction: t },
    );

    // Create items
    createdExpense.items = await Promise.all(
      itemsData.map(attachmentData => {
        return models.ExpenseItem.createFromData(attachmentData, remoteUser, createdExpense, t);
      }),
    );

    // Create attached files
    createdExpense.attachedFiles = await createAttachedFiles(createdExpense, expenseData.attachedFiles, remoteUser, t);

    return createdExpense;
  });

  expense.user = remoteUser;
  expense.collective = collective;
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_CREATED, remoteUser);
  return expense;
}

/** Returns true if the expense should by put back to PENDING after this update */
export const changesRequireStatusUpdate = (
  expense: typeof models.Expense,
  newExpenseData: ExpenseData,
  hasItemsChanges: boolean,
  hasPayoutChanges: boolean,
): boolean => {
  const updatedValues = { ...expense.dataValues, ...newExpenseData };
  const hasAmountChanges = typeof updatedValues.amount !== 'undefined' && updatedValues.amount !== expense.amount;
  const isPaidCreditCardCharge = expense.type === EXPENSE_TYPE.CHARGE && expense.status === expenseStatus.PAID;

  if (isPaidCreditCardCharge && !hasAmountChanges) {
    return false;
  }
  return hasItemsChanges || hasAmountChanges || hasPayoutChanges;
};

/** Returns infos about the changes made to items */
export const getItemsChanges = async (
  existingItems: ExpenseItem[],
  expenseData: ExpenseData,
): Promise<
  [boolean, Record<string, unknown>[], [Record<string, unknown>[], ExpenseItem[], Record<string, unknown>[]]]
> => {
  if (expenseData.items) {
    const itemsDiff = models.ExpenseItem.diffDBEntries(existingItems, expenseData.items);
    const hasItemChanges = flatten(<unknown[]>itemsDiff).length > 0;
    return [hasItemChanges, expenseData.items, itemsDiff];
  } else {
    return [false, [], [[], [], []]];
  }
};

/*
 * Validate the account holder name against the legal name. Following cases are considered a match,
 *
 * 1) Punctuation are ignored; "Evil Corp, Inc" and "Evil Corp, Inc." are considered a match.
 * 2) Accents are ignored; "François" and "Francois" are considered a match.
 * 3) The first name and last name order is ignored; "Benjamin Piouffle" and "Piouffle Benjamin" is considered a match.
 * 4) If one of account holder name or legal name is not defined then this function returns true.
 */
export const isAccountHolderNameAndLegalNameMatch = (accountHolderName: string, legalName: string): boolean => {
  // Ignore 501(c)(3) in both account holder name and legal name
  legalName = legalName.replace(/501\(c\)\(3\)/g, '');
  accountHolderName = accountHolderName.replace(/501\(c\)\(3\)/g, '');

  const namesArray = legalName.trim().split(' ');
  let legalNameReversed;
  if (namesArray.length === 2) {
    const firstName = namesArray[0];
    const lastName = namesArray[1];
    legalNameReversed = `${lastName} ${firstName}`;
  }
  return !(
    accountHolderName.localeCompare(legalName, undefined, {
      sensitivity: 'base',
      ignorePunctuation: true,
    }) &&
    accountHolderName.localeCompare(legalNameReversed, undefined, {
      sensitivity: 'base',
      ignorePunctuation: true,
    })
  );
};

export async function editExpense(
  req: express.Request,
  expenseData: ExpenseData,
  options = {},
): Promise<typeof models.Expense> {
  const remoteUser = options?.['overrideRemoteUser'] || req.remoteUser;
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to edit an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const expense = await models.Expense.findByPk(expenseData.id, {
    include: [
      { model: models.Collective, as: 'collective', include: [{ association: 'host', required: false }] },
      { model: models.Collective, as: 'fromCollective' },
      { model: models.ExpenseAttachedFile, as: 'attachedFiles' },
      { model: models.PayoutMethod },
      { association: 'items' },
    ],
  });

  const [hasItemChanges, itemsData, itemsDiff] = await getItemsChanges(expense.items, expenseData);
  const taxes = expenseData.tax || expense.data?.taxes || [];
  const expenseType = expenseData.type || expense.type;
  checkTaxes(expense.collective, expense.collective.host, expenseType, taxes);

  if (!expense) {
    throw new NotFound('Expense not found');
  }

  const modifiedFields = Object.keys(omitBy(expenseData, (value, key) => key === 'id' || isNil(value)));
  if (isEqual(modifiedFields, ['tags'])) {
    // Special mode when editing **only** tags: we don't care about the expense status there
    if (!(await canEditExpenseTags(req, expense))) {
      throw new Unauthorized("You don't have permission to edit tags for this expense");
    }

    return expense.update({ tags: expenseData.tags });
  }

  if (!options?.['skipPermissionCheck'] && !(await canEditExpense(req, expense))) {
    throw new Unauthorized("You don't have permission to edit this expense");
  }

  const isPaidCreditCardCharge =
    expense.type === EXPENSE_TYPE.CHARGE && expense.status === expenseStatus.PAID && Boolean(expense.VirtualCardId);

  if (isPaidCreditCardCharge && !hasItemChanges) {
    throw new ValidationFailed(
      'You need to include Expense Items when adding missing information to card charge expenses',
    );
  }

  if (size(expenseData.attachedFiles) > 15) {
    throw new ValidationFailed('The number of files that you can attach to an expense is limited to 15');
  }

  // Load the payee profile
  const fromCollective = expenseData.fromCollective || expense.fromCollective;
  if (expenseData.fromCollective && expenseData.fromCollective.id !== expense.fromCollective.id) {
    if (!options?.['skipPermissionCheck'] && !remoteUser.isAdminOfCollective(fromCollective)) {
      throw new ValidationFailed('You must be an admin of the account to submit an expense in its name');
    } else if (!fromCollective.canBeUsedAsPayoutProfile()) {
      throw new ValidationFailed('This account cannot be used for payouts');
    }
  }

  // Let's take the opportunity to update collective's location
  if (expenseData.payeeLocation?.address && !fromCollective.location.address) {
    await fromCollective.update({
      address: expenseData.payeeLocation.address,
      countryISO: expenseData.payeeLocation.country,
    });
  }

  const cleanExpenseData = pick(
    expenseData,
    isPaidCreditCardCharge ? EXPENSE_PAID_CHARGE_EDITABLE_FIELDS : EXPENSE_EDITABLE_FIELDS,
  );

  // Let submitter customize the currency
  const { collective } = expense;
  const host = await collective.getHostCollective();
  const isChangingCurrency = expenseData.currency && expenseData.currency !== expense.currency;
  if (isChangingCurrency && expenseData.currency !== collective.currency && !hasMultiCurrency(collective, host)) {
    throw new FeatureNotSupportedForCollective('Multi-currency expenses are not enabled for this account');
  }

  let payoutMethod = await expense.getPayoutMethod();
  let feesPayer = expense.feesPayer;

  // Validate bank account payout method
  if (payoutMethod?.type === PayoutMethodTypes.BANK_ACCOUNT) {
    const payoutMethodData = <BankAccountPayoutMethodData>payoutMethod.data;
    const accountHolderName = payoutMethodData?.accountHolderName;
    const legalName = <string>expenseData.fromCollective.legalName;
    if (accountHolderName && legalName && !isAccountHolderNameAndLegalNameMatch(accountHolderName, legalName)) {
      logger.warn('The legal name should match the bank account holder name (${accountHolderName} ≠ ${legalName})');
    }
  }
  const updatedExpense = await sequelize.transaction(async t => {
    // Update payout method if we get new data from one of the param for it
    if (
      !isPaidCreditCardCharge &&
      expenseData.payoutMethod !== undefined &&
      expenseData.payoutMethod?.id !== expense.PayoutMethodId
    ) {
      payoutMethod = await getPayoutMethodFromExpenseData(expenseData, remoteUser, fromCollective, t);

      // Reset fees payer when changing the payout method and the new one doesn't support it
      if (feesPayer === ExpenseFeesPayer.PAYEE && !models.PayoutMethod.typeSupportsFeesPayer(payoutMethod?.type)) {
        feesPayer = ExpenseFeesPayer.COLLECTIVE;
      }
    }

    // Update items
    if (hasItemChanges) {
      checkExpenseItems({ ...expense.dataValues, ...cleanExpenseData }, itemsData, taxes);
      const [newItemsData, oldItems, itemsToUpdate] = itemsDiff;
      await Promise.all(<Promise<void>[]>[
        // Delete
        ...oldItems.map(item => {
          return item.destroy({ transaction: t });
        }),
        // Create
        ...newItemsData.map(itemData => {
          return models.ExpenseItem.createFromData(itemData, remoteUser, expense, t);
        }),
        // Update
        ...itemsToUpdate.map(itemData => {
          return models.ExpenseItem.updateFromData(itemData, t);
        }),
      ]);
    }

    // Update expense
    // When updating amount, attachment or payoutMethod, we reset its status to PENDING
    const PayoutMethodId = payoutMethod ? payoutMethod.id : null;
    const shouldUpdateStatus = changesRequireStatusUpdate(
      expense,
      expenseData,
      hasItemChanges,
      PayoutMethodId !== expense.PayoutMethodId,
    );

    // Update attached files
    if (expenseData.attachedFiles) {
      const [newAttachedFiles, removedAttachedFiles, updatedAttachedFiles] = models.ExpenseAttachedFile.diffDBEntries(
        expense.attachedFiles,
        expenseData.attachedFiles,
      );

      await createAttachedFiles(expense, newAttachedFiles, remoteUser, t);
      await Promise.all(removedAttachedFiles.map((file: ExpenseAttachedFile) => file.destroy()));
      await Promise.all(
        updatedAttachedFiles.map((file: Record<string, unknown>) =>
          models.ExpenseAttachedFile.update({ url: file.url }, { where: { id: file.id, ExpenseId: expense.id } }),
        ),
      );
    }

    const updatedExpenseProps = {
      ...cleanExpenseData,
      data: !expense.data ? null : cloneDeep(expense.data),
      amount: computeTotalAmountForExpense(expenseData.items || expense.items, taxes),
      lastEditedById: remoteUser.id,
      incurredAt: expenseData.incurredAt || new Date(),
      status: shouldUpdateStatus ? 'PENDING' : expense.status,
      FromCollectiveId: fromCollective.id,
      PayoutMethodId: PayoutMethodId,
      legacyPayoutMethod: models.Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
      tags: cleanExpenseData.tags,
    };

    if (isPaidCreditCardCharge) {
      set(updatedExpenseProps, 'data.missingDetails', false);
    }
    if (!isEqual(expense.data?.taxes, taxes)) {
      set(updatedExpenseProps, 'data.taxes', taxes);
    }
    return expense.update(updatedExpenseProps, { transaction: t });
  });

  if (isPaidCreditCardCharge) {
    if (cleanExpenseData.description) {
      await models.Transaction.update(
        { description: cleanExpenseData.description },
        { where: { ExpenseId: updatedExpense.id } },
      );
    }

    // Auto Resume Virtual Card
    if (host?.settings?.virtualcards?.autopause) {
      const virtualCard = await expense.getVirtualCard();
      const expensesMissingReceipts = await virtualCard.getExpensesMissingDetails();
      if (virtualCard.isPaused() && expensesMissingReceipts.length > 0) {
        await virtualCard.resume();
      }
    }
  } else {
    await updatedExpense.createActivity(activities.COLLECTIVE_EXPENSE_UPDATED, remoteUser);
  }

  return updatedExpense;
}

export async function deleteExpense(req: express.Request, expenseId: number): Promise<typeof models.Expense> {
  const { remoteUser } = req;
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to delete an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const expense = await models.Expense.findByPk(expenseId, {
    include: [{ model: models.Collective, as: 'collective' }],
  });

  if (!expense) {
    throw new NotFound('Expense not found');
  }

  if (!(await canDeleteExpense(req, expense))) {
    throw new Unauthorized(
      "You don't have permission to delete this expense or it needs to be rejected before being deleted",
    );
  }

  const res = await expense.destroy();
  return res;
}

/** Helper that finishes the process of paying an expense */
async function markExpenseAsPaid(expense, remoteUser, isManualPayout = false): Promise<typeof models.Expense> {
  debug('update expense status to PAID', expense.id);
  await expense.setPaid(remoteUser.id);
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_PAID, remoteUser, { isManualPayout });
  return expense;
}

async function payExpenseWithPayPalAdaptive(remoteUser, expense, host, paymentMethod, toPaypalEmail, fees = {}) {
  debug('payExpenseWithPayPalAdaptive', expense.id);

  if (expense.currency !== expense.collective.currency) {
    throw new Error(
      'Multi-currency expenses are not supported by the legacy PayPal adaptive implementation. Please migrate to PayPal payouts.',
    );
  }

  try {
    const paymentResponse = await paymentProviders.paypal.types['adaptive'].pay(
      expense.collective,
      expense,
      toPaypalEmail,
      paymentMethod.token,
    );

    const { createPaymentResponse, executePaymentResponse } = paymentResponse;

    switch (executePaymentResponse.paymentExecStatus) {
      case 'COMPLETED':
        break;

      case 'CREATED':
        /*
         * When we don't provide a preapprovalKey (paymentMethod.token) to payServices['paypal'](),
         * it creates a payKey that we can use to redirect the user to PayPal.com to manually approve that payment
         * TODO We should handle that case on the frontend
         */
        throw new errors.BadRequest(
          `Please approve this payment manually on ${createPaymentResponse.paymentApprovalUrl}`,
        );

      case 'ERROR':
        // Backward compatible error message parsing
        // eslint-disable-next-line no-case-declarations
        const errorMessage =
          executePaymentResponse.payErrorList?.payError?.[0].error?.message ||
          executePaymentResponse.payErrorList?.[0].error?.message;
        throw new errors.ServerError(
          `Error while paying the expense with PayPal: "${errorMessage}". Please contact support@opencollective.com or pay it manually through PayPal.`,
        );

      default:
        throw new errors.ServerError(
          `Error while paying the expense with PayPal. Please contact support@opencollective.com or pay it manually through PayPal.`,
        );
    }

    // Warning senderFees can be null
    const senderFees = createPaymentResponse.defaultFundingPlan.senderFees;
    const paymentProcessorFeeInCollectiveCurrency = senderFees ? senderFees.amount * 100 : 0; // paypal sends this in float
    const currencyConversion = createPaymentResponse.defaultFundingPlan.currencyConversion || { exchangeRate: 1 };
    const hostCurrencyFxRate = 1 / parseFloat(currencyConversion.exchangeRate); // paypal returns a float from host.currency to expense.currency
    fees['paymentProcessorFeeInHostCurrency'] = Math.round(
      hostCurrencyFxRate * paymentProcessorFeeInCollectiveCurrency,
    );

    // Adaptive does not work with multi-currency expenses, so we can safely assume that expense.currency = collective.currency
    await createTransactionsFromPaidExpense(host, expense, fees, hostCurrencyFxRate, paymentResponse, paymentMethod);
    const updatedExpense = await markExpenseAsPaid(expense, remoteUser);
    await paymentMethod.updateBalance();
    return updatedExpense;
  } catch (err) {
    debug('paypal> error', JSON.stringify(err, null, '  '));
    if (
      err.message.indexOf('The total amount of all payments exceeds the maximum total amount for all payments') !== -1
    ) {
      throw new ValidationFailed(
        'Not enough funds in your existing Paypal preapproval. Please refill your PayPal payment balance.',
      );
    } else {
      throw new BadRequest(err.message);
    }
  }
}

const matchFxRateWithCurrency = (
  expectedSourceCurrency: string,
  expectedTargetCurrency: string,
  rateSourceCurrency: string,
  rateTargetCurrency: string,
  rate: number | null | undefined,
) => {
  if (!rate) {
    return null;
  } else if (expectedSourceCurrency === rateSourceCurrency && expectedTargetCurrency === rateTargetCurrency) {
    return rate;
  } else if (expectedSourceCurrency === rateTargetCurrency && expectedTargetCurrency === rateSourceCurrency) {
    return 1 / rate;
  }
};

const getWiseFxRateInfoFromExpenseData = (expense, expectedSourceCurrency: string, expectedTargetCurrency: string) => {
  if (expectedSourceCurrency === expectedTargetCurrency) {
    return { value: 1 };
  }

  const wiseInfo: WiseTransfer | WiseQuote | WiseQuoteV2 = expense.data?.transfer || expense.data?.quote;
  if (wiseInfo?.rate) {
    const wiseSourceCurrency = wiseInfo['sourceCurrency'] || wiseInfo['source'];
    const wiseTargetCurrency = wiseInfo['targetCurrency'] || wiseInfo['target'];
    const fxRate = matchFxRateWithCurrency(
      expectedSourceCurrency,
      expectedTargetCurrency,
      wiseSourceCurrency,
      wiseTargetCurrency,
      wiseInfo.rate,
    );
    if (fxRate) {
      return {
        value: fxRate,
        date: new Date(wiseInfo['created'] || wiseInfo['createdTime']), // "created" for transfers, "createdTime" for quotes
        isFinal: Boolean(expense.data?.transfer),
      };
    }
  }
};

export async function createTransferWiseTransactionsAndUpdateExpense({ host, expense, data, fees, remoteUser }) {
  if (host.settings?.transferwise?.ignorePaymentProcessorFees) {
    // TODO: We should not just ignore fees, they should be recorded as a transaction from the host to the collective
    // See https://github.com/opencollective/opencollective/issues/5113
    fees.paymentProcessorFeeInHostCurrency = 0;
  } else if (data?.paymentOption?.fee?.total) {
    fees.paymentProcessorFeeInHostCurrency = Math.round(data.paymentOption.fee.total * 100);
  }

  // Get FX rate
  const wiseFxRateInfo = getWiseFxRateInfoFromExpenseData(expense, expense.currency, host.currency);
  if (!wiseFxRateInfo) {
    logger.warn(`Could not retrieve the FX rate from Wise for expense #${expense.id}. Falling back to 'auto' mode.`);
  }

  await createTransactionsFromPaidExpense(host, expense, fees, wiseFxRateInfo?.value || 'auto', data);
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_PROCESSING, remoteUser);
  await expense.setProcessing(remoteUser.id);
  return expense;
}

/**
 * A soft lock on expenses, that works by adding a `isLocked` flag on expense's data
 */
const lockExpense = async (id, callback) => {
  // Lock expense
  await sequelize.transaction(async sqlTransaction => {
    const expense = await models.Expense.findByPk(id, { lock: true, transaction: sqlTransaction });

    if (!expense) {
      throw new Unauthorized('Expense not found');
    } else if (expense.data?.isLocked) {
      throw new Error('This expense is already been processed, please try again later');
    } else {
      return expense.update({ data: { ...expense.data, isLocked: true } }, { transaction: sqlTransaction });
    }
  });

  try {
    return await callback();
  } finally {
    // Unlock expense
    const expense = await models.Expense.findByPk(id);
    await expense.update({ data: { ...expense.data, isLocked: false } });
  }
};

type FeesArgs = {
  paymentProcessorFeeInCollectiveCurrency?: number;
  hostFeeInCollectiveCurrency?: number;
  platformFeeInCollectiveCurrency?: number;
};

/**
 * Estimates the fees for an expense
 */
export const getExpenseFees = async (
  expense,
  host,
  { fees = {}, payoutMethod, forceManual, useExistingWiseData = false },
): Promise<{
  feesInHostCurrency: {
    paymentProcessorFeeInHostCurrency: number;
    hostFeeInHostCurrency: number;
    platformFeeInHostCurrency: number;
  };
  feesInExpenseCurrency: {
    paymentProcessorFee?: number;
    hostFee?: number;
    platformFee?: number;
  };
  feesInCollectiveCurrency: FeesArgs;
}> => {
  const resultFees = { ...fees };
  const feesInHostCurrency = {
    paymentProcessorFeeInHostCurrency: undefined,
    hostFeeInHostCurrency: undefined,
    platformFeeInHostCurrency: undefined,
  };

  if (!expense.collective) {
    expense.collective = await models.Collective.findByPk(expense.CollectiveId);
  }

  const collectiveToHostFxRate = await getFxRate(expense.collective.currency, host.currency);
  const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();

  if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT && !forceManual) {
    const [connectedAccount] = await host.getConnectedAccounts({
      where: { service: 'transferwise', deletedAt: null },
    });
    if (!connectedAccount) {
      throw new Error('Host is not connected to Transferwise');
    }
    const quote = useExistingWiseData
      ? expense.data.quote
      : await paymentProviders.transferwise.getTemporaryQuote(connectedAccount, payoutMethod, expense);
    const paymentOption = useExistingWiseData
      ? expense.data.paymentOption
      : quote.paymentOptions.find(p => p.payIn === 'BALANCE' && p.payOut === quote.payOut);
    if (!paymentOption) {
      throw new BadRequest(`Could not find available payment option for this transaction.`, null, quote);
    }
    // Notice this is the FX rate between Host and Collective, that's why we use `collectiveToHostFxRate`.
    resultFees['paymentProcessorFeeInCollectiveCurrency'] = floatAmountToCents(
      paymentOption.fee.total / collectiveToHostFxRate,
    );
  } else if (payoutMethodType === PayoutMethodTypes.PAYPAL && !forceManual) {
    resultFees['paymentProcessorFeeInCollectiveCurrency'] = await paymentProviders.paypal.types['adaptive'].fees({
      amount: expense.amount,
      currency: expense.collective.currency,
      host,
    });
  }

  // Build fees in host currency
  feesInHostCurrency.paymentProcessorFeeInHostCurrency = Math.round(
    collectiveToHostFxRate * (<number>resultFees['paymentProcessorFeeInCollectiveCurrency'] || 0),
  );
  feesInHostCurrency.hostFeeInHostCurrency = Math.round(
    collectiveToHostFxRate * (<number>fees['hostFeeInCollectiveCurrency'] || 0),
  );
  feesInHostCurrency.platformFeeInHostCurrency = Math.round(
    collectiveToHostFxRate * (<number>resultFees['platformFeeInCollectiveCurrency'] || 0),
  );

  if (!resultFees['paymentProcessorFeeInCollectiveCurrency']) {
    resultFees['paymentProcessorFeeInCollectiveCurrency'] = 0;
  }

  // Build fees in expense currency
  let feesInExpenseCurrency = {};
  if (expense.currency === expense.collective.currency) {
    feesInExpenseCurrency = {
      paymentProcessorFee: resultFees['paymentProcessorFeeInCollectiveCurrency'],
      hostFee: resultFees['hostFeeInCollectiveCurrency'],
      platformFee: resultFees['platformFeeInCollectiveCurrency'],
    };
  } else {
    const collectiveToExpenseFxRate = await getFxRate(expense.collective.currency, expense.currency);
    const applyCollectiveToExpenseFxRate = (amount: number) => Math.round((amount || 0) * collectiveToExpenseFxRate);
    feesInExpenseCurrency = {
      paymentProcessorFee: applyCollectiveToExpenseFxRate(resultFees['paymentProcessorFeeInCollectiveCurrency']),
      hostFee: applyCollectiveToExpenseFxRate(resultFees['hostFeeInCollectiveCurrency']),
      platformFee: applyCollectiveToExpenseFxRate(resultFees['platformFeeInCollectiveCurrency']),
    };
  }

  return { feesInCollectiveCurrency: resultFees, feesInHostCurrency, feesInExpenseCurrency };
};

const generateInsufficientBalanceErrorMessage = ({
  object,
  balance,
  currency,
  expenseAmount,
  isSameCurrency,
  fees = 0,
  feesName = '',
}) => {
  let msg = `Collective does not have enough funds to ${object}.`;
  msg += ` Current balance: ${formatCurrency(balance, currency)}`;
  msg += `, Expense amount: ${formatCurrency(expenseAmount, currency)}`;
  if (fees) {
    msg += `, Estimated ${feesName} fees: ${formatCurrency(fees, currency)}`;
  }

  if (!isSameCurrency) {
    msg += `. For expenses submitted in a different currency than the collective, an error margin of 20% is applied. The maximum amount that can be paid is ${formatCurrency(
      Math.round(balance / 1.2),
      currency,
    )}`;
  }

  return msg;
};

/**
 * Check if the collective balance is enough to pay the expense. Throws if not.
 */
export const checkHasBalanceToPayExpense = async (
  host,
  expense,
  payoutMethod,
  { forceManual = false, manualFees = {}, useExistingWiseData = false } = {},
) => {
  const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();
  const balanceInExpenseCurrency = await expense.collective.getBalanceWithBlockedFunds({ currency: expense.currency });
  const isSameCurrency = expense.currency === expense.collective.currency;

  // Ensure the collective has enough funds to pay the expense, with an error margin of 20% of the expense amount
  // to account for fluctuating rates. Example: to pay for a $100 expense in euros, the collective needs to have at least $120.
  const getMinExpectedBalance = amountToPay => (isSameCurrency ? amountToPay : Math.round(amountToPay * 1.2));

  // Check base balance before fees
  if (balanceInExpenseCurrency < getMinExpectedBalance(expense.amount)) {
    throw new Unauthorized(
      generateInsufficientBalanceErrorMessage({
        object: 'pay this expense',
        balance: balanceInExpenseCurrency,
        currency: expense.currency,
        expenseAmount: expense.amount,
        isSameCurrency,
      }),
    );
  }

  const { feesInHostCurrency, feesInCollectiveCurrency, feesInExpenseCurrency } = await getExpenseFees(expense, host, {
    fees: manualFees,
    payoutMethod,
    forceManual,
    useExistingWiseData,
  });

  // Estimate the total amount to pay from the collective, based on who's supposed to pay the fee
  let totalAmountToPay;
  if (expense.feesPayer === 'COLLECTIVE') {
    totalAmountToPay = expense.amount + feesInExpenseCurrency.paymentProcessorFee;
  } else if (expense.feesPayer === 'PAYEE') {
    totalAmountToPay = expense.amount; // Ignore the fee as it will be deduced from the payee
    if (!models.PayoutMethod.typeSupportsFeesPayer(payoutMethodType)) {
      throw new Error(
        'Putting the payment processor fees on the payee is only supported for bank accounts and manual payouts at the moment',
      );
    } else if (expense.currency !== expense.collective.currency) {
      throw new Error(
        'Cannot put the payment processor fees on the payee when the expense currency is not the same as the collective currency',
      );
    }
  } else {
    throw new Error(`Expense fee payer "${expense.feesPayer}" not supported yet`);
  }

  // Ensure the collective has enough funds to cover the fees for this expense, with an error margin of 20% of the expense amount
  // to account for fluctuating rates. Example: to pay for a $100 expense in euros, the collective needs to have at least $120.
  if (balanceInExpenseCurrency < getMinExpectedBalance(totalAmountToPay)) {
    throw new Error(
      generateInsufficientBalanceErrorMessage({
        object: 'cover for the fees of this payment method',
        balance: balanceInExpenseCurrency,
        currency: expense.currency,
        expenseAmount: expense.amount,
        isSameCurrency,
        fees: feesInExpenseCurrency.paymentProcessorFee,
        feesName: payoutMethodType,
      }),
    );
  }

  return { feesInCollectiveCurrency, feesInExpenseCurrency, feesInHostCurrency, totalAmountToPay };
};

/**
 * Pay an expense based on the payout method defined in the Expense object
 * @PRE: fees { id, paymentProcessorFeeInCollectiveCurrency, hostFeeInCollectiveCurrency, platformFeeInCollectiveCurrency }
 * Note: some payout methods like PayPal will automatically define `paymentProcessorFeeInCollectiveCurrency`
 */
export async function payExpense(req: express.Request, args: Record<string, unknown>): Promise<typeof models.Expense> {
  const { remoteUser } = req;
  const expenseId = args.id;
  const forceManual = Boolean(args.forceManual);

  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to pay an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const expense = await lockExpense(args.id, async () => {
    const expense = await models.Expense.findByPk(expenseId, {
      include: [
        { model: models.Collective, as: 'collective' },
        { model: models.Collective, as: 'fromCollective' },
      ],
    });
    if (!expense) {
      throw new Unauthorized('Expense not found');
    }
    if (expense.status === statuses.PAID) {
      throw new Unauthorized('Expense has already been paid');
    }
    if (expense.status === statuses.PROCESSING) {
      throw new Unauthorized(
        'Expense is currently being processed, this means someone already started the payment process',
      );
    }
    if (
      expense.status !== statuses.APPROVED &&
      // Allow errored expenses to be marked as paid
      !(expense.status === statuses.ERROR)
    ) {
      throw new Unauthorized(`Expense needs to be approved. Current status of the expense: ${expense.status}.`);
    }
    if (!(await canPayExpense(req, expense))) {
      throw new Unauthorized("You don't have permission to pay this expense");
    }
    const host = await expense.collective.getHostCollective();
    if (expense.currency !== expense.collective.currency && !hasMultiCurrency(expense.collective, host)) {
      throw new Unauthorized('Multi-currency expenses are not enabled for this collective');
    }

    if (expense.legacyPayoutMethod === 'donation') {
      throw new Error('"In kind" donations are not supported anymore');
    }

    if (args.feesPayer && args.feesPayer !== expense.feesPayer) {
      await expense.update({ feesPayer: args.feesPayer });
    }

    const payoutMethod = await expense.getPayoutMethod();
    const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();
    const { feesInHostCurrency } = await checkHasBalanceToPayExpense(host, expense, payoutMethod, {
      forceManual,
      manualFees: <FeesArgs>(
        pick(args, [
          'paymentProcessorFeeInCollectiveCurrency',
          'hostFeeInCollectiveCurrency',
          'platformFeeInCollectiveCurrency',
        ])
      ),
    });

    // 2FA for payouts
    const isTwoFactorAuthenticationRequiredForPayoutMethod = [
      PayoutMethodTypes.PAYPAL,
      PayoutMethodTypes.BANK_ACCOUNT,
    ].includes(payoutMethodType);
    const hostHasPayoutTwoFactorAuthenticationEnabled = get(host, 'settings.payoutsTwoFactorAuth.enabled', false);
    const useTwoFactorAuthentication =
      isTwoFactorAuthenticationRequiredForPayoutMethod && !forceManual && hostHasPayoutTwoFactorAuthenticationEnabled;

    if (useTwoFactorAuthentication) {
      await handleTwoFactorAuthenticationPayoutLimit(req.remoteUser, args.twoFactorAuthenticatorCode, expense);
    }

    try {
      // Pay expense based on chosen payout method
      if (payoutMethodType === PayoutMethodTypes.PAYPAL) {
        const paypalEmail = payoutMethod.data.email;
        let paypalPaymentMethod = null;
        try {
          paypalPaymentMethod = await host.getPaymentMethod({ service: 'paypal', type: 'adaptive' });
        } catch {
          // ignore missing paypal payment method
        }
        // If the expense has been filed with the same paypal email than the host paypal
        // then we simply mark the expense as paid
        if (paypalPaymentMethod && paypalEmail === paypalPaymentMethod.name) {
          feesInHostCurrency['paymentProcessorFeeInHostCurrency'] = 0;
          await createTransactionsFromPaidExpense(host, expense, feesInHostCurrency, 'auto');
        } else if (forceManual) {
          await createTransactionsFromPaidExpense(host, expense, feesInHostCurrency, 'auto');
        } else if (paypalPaymentMethod) {
          return payExpenseWithPayPalAdaptive(
            remoteUser,
            expense,
            host,
            paypalPaymentMethod,
            paypalEmail,
            feesInHostCurrency,
          );
        } else {
          throw new Error('No Paypal account linked, please reconnect Paypal or pay manually');
        }
      } else if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT) {
        if (forceManual) {
          await createTransactionsFromPaidExpense(host, expense, feesInHostCurrency, 'auto');
        } else {
          const [connectedAccount] = await host.getConnectedAccounts({
            where: { service: 'transferwise', deletedAt: null },
          });
          if (!connectedAccount) {
            throw new Error('Host is not connected to Transferwise');
          }

          const data = await paymentProviders.transferwise.payExpense(connectedAccount, payoutMethod, expense);

          // Early return, Webhook will mark expense as Paid when the transaction completes.
          return createTransferWiseTransactionsAndUpdateExpense({
            host,
            expense,
            data,
            fees: feesInHostCurrency,
            remoteUser,
          });
        }
      } else if (payoutMethodType === PayoutMethodTypes.ACCOUNT_BALANCE) {
        const payee = expense.fromCollective;
        const payeeHost = await payee.getHostCollective();
        if (!payeeHost) {
          throw new Error('The payee needs to have an Host to able to be paid on its Open Collective balance.');
        }
        if (host.id !== payeeHost.id) {
          throw new Error(
            'The payee needs to be on the same Host than the payer to be paid on its Open Collective balance.',
          );
        }
        await createTransactionsFromPaidExpense(host, expense, feesInHostCurrency, 'auto');
      } else if (expense.legacyPayoutMethod === 'manual' || expense.legacyPayoutMethod === 'other') {
        // note: we need to check for manual and other for legacy reasons
        await createTransactionsFromPaidExpense(host, expense, feesInHostCurrency, 'auto');
      }
    } catch (error) {
      if (useTwoFactorAuthentication) {
        await resetRollingPayoutLimitOnFailure(req.remoteUser, expense);
      }

      throw error;
    }

    return markExpenseAsPaid(expense, remoteUser, true);
  });

  return expense;
}

export async function markExpenseAsUnpaid(
  req: express.Request,
  expenseId: number,
  shouldRefundPaymentProcessorFee: boolean,
): Promise<typeof models.Expense> {
  const { remoteUser } = req;

  const updatedExpense = await lockExpense(expenseId, async () => {
    if (!remoteUser) {
      throw new Unauthorized('You need to be logged in to unpay an expense');
    } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
      throw new FeatureNotAllowedForUser();
    }

    const expense = await models.Expense.findByPk(expenseId, {
      include: [
        { model: models.Collective, as: 'collective' },
        { model: models.User, as: 'User' },
        { model: models.PayoutMethod },
      ],
    });

    if (!expense) {
      throw new NotFound('No expense found');
    }

    if (!(await canMarkAsUnpaid(req, expense))) {
      throw new Unauthorized("You don't have permission to mark this expense as unpaid");
    }

    if (expense.status !== statuses.PAID) {
      throw new Unauthorized('Expense has not been paid yet');
    }

    const transaction = await models.Transaction.findOne({
      where: {
        ExpenseId: expenseId,
        RefundTransactionId: null,
        kind: TransactionKind.EXPENSE,
        isRefund: false,
      },
      include: [{ model: models.Expense }],
    });

    const paymentProcessorFeeInHostCurrency = shouldRefundPaymentProcessorFee
      ? transaction.paymentProcessorFeeInHostCurrency
      : 0;
    await libPayments.createRefundTransaction(transaction, paymentProcessorFeeInHostCurrency, null, expense.User);

    return expense.update({ status: statuses.APPROVED, lastEditedById: remoteUser.id });
  });

  await updatedExpense.createActivity(activities.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID, remoteUser);
  return updatedExpense;
}

export async function quoteExpense(expense_, { req }) {
  const expense = await models.Expense.findByPk(expense_.id, {
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'fromCollective' },
    ],
  });
  const payoutMethod = await expense.getPayoutMethod();
  const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();
  if (!(await canPayExpense(req, expense))) {
    throw new Unauthorized("You don't have permission to pay this expense");
  }

  const host = await expense.collective.getHostCollective();
  if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT) {
    const [connectedAccount] = await host.getConnectedAccounts({
      where: { service: 'transferwise', deletedAt: null },
    });
    if (!connectedAccount) {
      throw new Error('Host is not connected to Transferwise');
    }

    const quote = await paymentProviders.transferwise.quoteExpense(connectedAccount, payoutMethod, expense);
    return quote;
  }
}

export const getExpenseAmountInDifferentCurrency = async (expense, toCurrency, req) => {
  // Small helper to quickly generate an Amount object with fxRate
  const buildAmount = (
    fxRatePercentage: number,
    fxRateSource: CurrencyExchangeRateSourceTypeEnum,
    isApproximate: boolean,
    date = expense.createdAt,
  ) => ({
    value: Math.round(expense.amount * fxRatePercentage),
    currency: toCurrency,
    exchangeRate: {
      value: fxRatePercentage,
      source: fxRateSource,
      fromCurrency: expense.currency,
      toCurrency: toCurrency,
      date: date || expense.createdAt,
      isApproximate,
    },
  });

  // Simple case: no conversion needed
  if (toCurrency === expense.currency) {
    return { value: expense.amount, currency: expense.currency, exchangeRate: null };
  }

  // Retrieve existing FX rate based from payment provider payload (for already paid or quoted stuff)
  const { WISE, PAYPAL, OPENCOLLECTIVE } = CurrencyExchangeRateSourceTypeEnum;
  const payoutMethod = expense.PayoutMethodId && (await req.loaders.PayoutMethod.byId.load(expense.PayoutMethodId));

  if (payoutMethod) {
    if (payoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
      const wiseFxRateInfo = getWiseFxRateInfoFromExpenseData(expense, expense.currency, toCurrency);
      if (wiseFxRateInfo) {
        return buildAmount(wiseFxRateInfo.value, WISE, !wiseFxRateInfo.isFinal, wiseFxRateInfo.date);
      }
    } else if (payoutMethod.type === PayoutMethodTypes.PAYPAL) {
      const currencyConversion = expense.data?.['currency_conversion'];
      if (currencyConversion) {
        const fxRate = matchFxRateWithCurrency(
          expense.currency,
          toCurrency,
          currencyConversion['from_amount']['currency'],
          currencyConversion['to_amount']['currency'],
          parseFloat(currencyConversion['exchange_rate']),
        );

        if (fxRate) {
          const date = expense.data['time_processed'] ? new Date(expense.data['time_processed']) : null;
          return buildAmount(fxRate, PAYPAL, false, date);
        }
      }
    }
  }

  // TODO: Can we retrieve something for virtual cards?

  if (expense.status === 'PAID') {
    const rate = await req.loaders.Expense.expenseToHostTransactionFxRateLoader.load(expense.id);
    if (rate !== null) {
      return buildAmount(rate, OPENCOLLECTIVE, false, expense.createdAt);
    }
  }

  // Fallback on internal system
  const fxRate = await req.loaders.CurrencyExchangeRate.fxRate.load({ fromCurrency: expense.currency, toCurrency });
  return buildAmount(fxRate, OPENCOLLECTIVE, true);
};
