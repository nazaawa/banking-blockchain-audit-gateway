import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { WebhookProcessingStatus } from '../enums/mobile-money.enum';

/**
 * Journal durable des notifications de l'agregateur.
 *
 * `eventId` est unique : une relivraison du meme webhook ne peut donc jamais
 * produire un second appel SOAP.
 */
@Entity('mobile_money_webhook_events')
@Index('idx_mm_webhook_aggregator_reference', ['aggregatorReference'])
@Index('idx_mm_webhook_processing_status', ['processingStatus'])
export class MobileMoneyWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'event_id', type: 'varchar', length: 128, unique: true })
  eventId!: string;

  @Column({ name: 'aggregator_reference', type: 'varchar', length: 64 })
  aggregatorReference!: string;

  @Column({
    name: 'processing_status',
    type: 'enum',
    enum: WebhookProcessingStatus,
    default: WebhookProcessingStatus.RECEIVED,
  })
  processingStatus!: WebhookProcessingStatus;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ name: 'failure_reason', type: 'varchar', length: 1024, nullable: true })
  failureReason!: string | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
