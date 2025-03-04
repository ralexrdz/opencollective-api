import { GraphQLEnumType } from 'graphql';

export enum ORDER_BY_PSEUDO_FIELDS {
  MEMBER_COUNT = 'MEMBER_COUNT',
  TOTAL_CONTRIBUTED = 'TOTAL_CONTRIBUTED',
  CREATED_AT = 'CREATED_AT',
}

export const OrderByFieldType = new GraphQLEnumType({
  name: 'OrderByFieldType',
  description: 'Possible fields you can use to order by',
  values: {
    CREATED_AT: {},
    MEMBER_COUNT: {},
    TOTAL_CONTRIBUTED: {},
    ACTIVITY: {},
    RANK: {},
  },
});
