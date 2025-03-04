import { pick } from 'lodash';

import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import models from '.';

export enum HostApplicationStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

interface HostApplicationCreationAttributes {
  CollectiveId: number;
  HostCollectiveId: number;
  status: HostApplicationStatus;
  customData?: Record<string, unknown> | null;
  message?: string;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date | null;
}

export class HostApplication extends Model<HostApplication, HostApplicationCreationAttributes> {
  public readonly id!: number;
  public CollectiveId!: number;
  public HostCollectiveId!: number;
  public status!: HostApplicationStatus;
  public customData: Record<string, unknown> | null;
  public message: string;
  public createdAt!: Date;
  public updatedAt!: Date;
  public deletedAt: Date | null;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }

  // ---- Static ----

  static async getByStatus(
    host: typeof models.Collective,
    collective: typeof models.Collective,
    status: HostApplicationStatus,
  ): Promise<HostApplication | null> {
    return this.findOne({
      order: [['createdAt', 'DESC']],
      where: {
        HostCollectiveId: <number>host.id,
        CollectiveId: collective.id,
        status,
      },
    });
  }

  static async recordApplication(
    host: typeof models.Collective,
    collective: typeof models.Collective,
    data: Record<string, unknown>,
  ): Promise<HostApplication> {
    const existingApplication = await this.getByStatus(host, collective, HostApplicationStatus.PENDING);
    if (existingApplication) {
      return existingApplication.update({ updatedAt: new Date() });
    } else {
      return this.create({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        status: HostApplicationStatus.PENDING,
        ...(<Record<string, unknown>>pick(data, ['message', 'customData'])),
      });
    }
  }

  /**
   * Update the `status` for pending application(s) for this `host` <> `collective` (if any)
   */
  static async updatePendingApplications(
    host: typeof models.Collective,
    collective: typeof models.Collective,
    status: HostApplicationStatus,
  ): Promise<void> {
    await this.update(
      { status },
      {
        where: {
          HostCollectiveId: host.id,
          CollectiveId: collective.id,
          status: HostApplicationStatus.PENDING,
        },
      },
    );
  }
}

function setupModel(HostApplication) {
  // Link the model to database fields
  HostApplication.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      CollectiveId: {
        type: DataTypes.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      HostCollectiveId: {
        type: DataTypes.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM(...Object.values(HostApplicationStatus)),
        allowNull: false,
        validate: {
          isIn: {
            args: [Object.values(HostApplicationStatus)],
            msg: `Must be one of: ${Object.values(HostApplicationStatus)}`,
          },
        },
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: true,
        validate: {
          len: [0, 3000],
        },
      },
      customData: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
      deletedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      sequelize,
      tableName: 'HostApplications',
      paranoid: true,
    },
  );
}

// We're using the setupModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
setupModel(HostApplication);

export default HostApplication;
