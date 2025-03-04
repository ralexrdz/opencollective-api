import fs from 'fs';

import handlebars from './handlebars';

/*
 * Loads all the email templates
 */

const templates = {};

export const templateNames = [
  'announcement',
  'archived.collective',
  'github.signup',
  'collective.apply',
  'collective.apply.for.host',
  'collective.approved',
  'collective.approved.foundation',
  'collective.approved.the-social-change-nest',
  'collective.rejected',
  'collective.comment.created',
  'collective.conversation.created',
  'collective.confirm',
  'collective.created',
  'collective.contact',
  'collective.frozen',
  'collective.unfrozen',
  'collective.created.opensource',
  'collective.expense.approved',
  'collective.expense.approved.for.host',
  'collective.expense.created',
  'collective.expense.processing',
  'collective.expense.error',
  'collective.expense.error.for.host',
  'collective.expense.paid',
  'collective.expense.paid.for.host',
  'collective.expense.invite.drafted',
  'collective.expense.missing.receipt',
  'collective.expense.recurring.drafted',
  'collective.expense.rejected',
  'collective.member.created',
  'collective.monthlyreport',
  'collective.newmember',
  'collective.update.published',
  'collective.virtualcard.added',
  'collective.virtualcard.missing.receipts',
  'collective.virtualcard.suspended',
  'confirm-guest-account',
  'event.reminder.1d',
  'event.reminder.7d',
  'fund.created.foundation',
  'fund.approved.foundation',
  'host.application.contact',
  'host.report',
  'host.report.summary',
  'member.invitation',
  'onboarding.day2',
  'onboarding.day2.foundation',
  'onboarding.day2.opensource',
  'onboarding.day2.organization',
  'onboarding.day3',
  'onboarding.day3.foundation',
  'onboarding.day3.opensource',
  'onboarding.noExpenses',
  'onboarding.noExpenses.opensource',
  'onboarding.noUpdates',
  'onboarding.day21.noTwitter',
  'onboarding.day7',
  'onboarding.day35.active',
  'onboarding.day35.inactive',
  'organization.collective.created',
  'organization.newmember',
  'payment.failed',
  'payment.creditcard.confirmation',
  'payment.creditcard.expiring',
  'order.processing',
  'order.crypto.processing',
  'order.new.pendingFinancialContribution',
  'order.reminder.pendingFinancialContribution',
  'report.platform',
  'report.platform.weekly',
  'subscription.canceled',
  'tax-form-request',
  'ticket.confirmed',
  'ticket.confirmed.fearlesscitiesbrussels',
  'ticket.confirmed.open-2020',
  'thankyou',
  'thankyou.wwcode',
  'thankyou.fr',
  'thankyou.foundation',
  'thankyou.opensource',
  'user.card.claimed',
  'user.card.invited',
  'user.changeEmail',
  'user.monthlyreport',
  'user.new.token',
  'user.yearlyreport',
  'backyourstack.dispatch.confirmed',
  'activated.collective.as.host',
  'activated.collective.as.independent',
  'deactivated.collective.as.host',
  'contribution.rejected',
  'virtualcard.requested',
  'authorization.declined',
];

const templatesPath = `${__dirname}/../../templates`;

// Register partials
const header = fs.readFileSync(`${templatesPath}/partials/header.hbs`, 'utf8');
const footer = fs.readFileSync(`${templatesPath}/partials/footer.hbs`, 'utf8');
const toplogo = fs.readFileSync(`${templatesPath}/partials/toplogo.hbs`, 'utf8');
const eventsnippet = fs.readFileSync(`${templatesPath}/partials/eventsnippet.hbs`, 'utf8');
const expenseItems = fs.readFileSync(`${templatesPath}/partials/expense-items.hbs`, 'utf8');
const eventdata = fs.readFileSync(`${templatesPath}/partials/eventdata.hbs`, 'utf8');
const collectivecard = fs.readFileSync(`${templatesPath}/partials/collectivecard.hbs`, 'utf8');
const chargeDateNotice = fs.readFileSync(`${templatesPath}/partials/charge_date_notice.hbs`, 'utf8');
const mthReportFooter = fs.readFileSync(`${templatesPath}/partials/monthlyreport.footer.hbs`, 'utf8');
const mthReportSubscription = fs.readFileSync(`${templatesPath}/partials/monthlyreport.subscription.hbs`, 'utf8');

handlebars.registerPartial('header', header);
handlebars.registerPartial('footer', footer);
handlebars.registerPartial('toplogo', toplogo);
handlebars.registerPartial('collectivecard', collectivecard);
handlebars.registerPartial('eventsnippet', eventsnippet);
handlebars.registerPartial('expenseItems', expenseItems);
handlebars.registerPartial('eventdata', eventdata);
handlebars.registerPartial('charge_date_notice', chargeDateNotice);
handlebars.registerPartial('mr-footer', mthReportFooter);
handlebars.registerPartial('mr-subscription', mthReportSubscription);

templateNames.forEach(template => {
  const source = fs.readFileSync(`${templatesPath}/emails/${template}.hbs`, 'utf8');
  templates[template] = handlebars.compile(source);
});

export default templates;
