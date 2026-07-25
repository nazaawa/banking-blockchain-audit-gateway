import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { Transaction } from './entities/transaction.entity';
import type { QueryTransfersDto } from './dto/query-transfers.dto';

/** Code PostgreSQL d'une violation de contrainte d'unicite. */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Acces aux donnees des transactions.
 *
 * Isole le service metier des specificites de TypeORM et de PostgreSQL
 * (codes d'erreur, construction des requetes paginees).
 */
@Injectable()
export class TransactionsRepository {
  constructor(
    @InjectRepository(Transaction)
    private readonly repository: Repository<Transaction>,
  ) {}

  create(data: Partial<Transaction>): Transaction {
    return this.repository.create(data);
  }

  async save(transaction: Transaction): Promise<Transaction> {
    return this.repository.save(transaction);
  }

  async findByReference(reference: string): Promise<Transaction | null> {
    return this.repository.findOne({ where: { reference } });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Transaction | null> {
    return this.repository.findOne({ where: { idempotencyKey } });
  }

  async existsByReference(reference: string): Promise<boolean> {
    return this.repository.exists({ where: { reference } });
  }

  /** Recherche paginee, triee du plus recent au plus ancien. */
  async paginate(query: QueryTransfersDto): Promise<[Transaction[], number]> {
    const { page, limit, status, currency } = query;

    return this.repository.findAndCount({
      where: {
        ...(status ? { status } : {}),
        ...(currency ? { currency } : {}),
      },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  /**
   * Detecte une violation d'unicite PostgreSQL, eventuellement ciblee sur une
   * contrainte precise (collision de reference vs rejeu d'idempotence).
   */
  isUniqueViolation(error: unknown, constraintHint?: string): boolean {
    if (!(error instanceof QueryFailedError)) return false;

    const driverError = error.driverError as { code?: string; constraint?: string } | undefined;
    if (driverError?.code !== PG_UNIQUE_VIOLATION) return false;
    if (!constraintHint) return true;

    const haystack = `${driverError.constraint ?? ''} ${error.message}`.toLowerCase();
    return haystack.includes(constraintHint.toLowerCase());
  }
}
