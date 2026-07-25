import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import type { TransactionEvent } from '../events/entities/transaction-event.entity';
import type { Transaction } from '../transactions/entities/transaction.entity';
import { PaymentChannel } from '../mobile-money/enums/mobile-money.enum';
import { JournalEntry } from './entities/journal-entry.entity';
import { JournalLine } from './entities/journal-line.entity';
import { EntryDirection, LedgerAccount, balanceOf } from './enums/ledger.enum';
import { POSTING_RULES } from './posting-rules';

/** Solde d'un compte, exprime dans le sens ou il augmente. */
export interface AccountBalance {
  account: LedgerAccount;
  debits: number;
  credits: number;
  balance: number;
}

/** Ecart entre le total des debits et celui des credits, tous comptes confondus. */
export interface TrialBalance {
  accounts: AccountBalance[];
  totalDebits: number;
  totalCredits: number;
  /** Doit toujours valoir zero : c'est la propriete que la partie double garantit. */
  difference: number;
  currency: string | null;
  entryCount: number;
}

/**
 * Comptabilisation en partie double des faits monetaires.
 *
 * ## Pourquoi un ledger, alors que les statuts existent deja
 *
 * Un statut dit *qu'une* dette existe ; il ne dit pas **combien**. Sur un ecart
 * de montant, `refund_status = REQUIRED` ne portait aucun montant : la somme due
 * n'etait deductible que par recoupement, et un remboursement partiel laissait
 * un reliquat parfaitement invisible.
 *
 * Le ledger rend cette dette chiffree, opposable, et surtout **verifiable** : la
 * somme des debits egale celle des credits, ou la base refuse l'ecriture.
 *
 * ## Perimetre
 *
 * Seuls les flux ou la passerelle detient des fonds sont comptabilises. Le
 * virement classique instruit la banque sans jamais rien detenir : il n'a pas
 * d'existence comptable ici, et lui en inventer une serait faux.
 */
@Injectable()
export class LedgerPostingService {
  private readonly logger = new Logger(LedgerPostingService.name);

  constructor(
    @InjectRepository(JournalEntry)
    private readonly entries: Repository<JournalEntry>,
    @InjectRepository(JournalLine)
    private readonly lines: Repository<JournalLine>,
  ) {}

  /**
   * Comptabilise la consequence d'un fait, s'il en a une.
   *
   * Appele dans la transaction SQL qui consigne le fait : l'ecriture et le fait
   * apparaissent ensemble ou pas du tout. Un fait monetaire sans ecriture
   * rendrait le ledger faux sans que rien ne le signale.
   */
  async post(
    event: TransactionEvent,
    transaction: Transaction,
    manager?: EntityManager,
  ): Promise<JournalEntry | null> {
    // Les faits monetaires sont tous consignes dans une transaction SQL ; le
    // repli n'existe que pour ne pas rendre la signature trompeuse.
    const em = manager ?? this.entries.manager;
    if (transaction.paymentChannel !== PaymentChannel.MOBILE_MONEY) return null;

    const rule = POSTING_RULES[event.eventType];
    if (!rule) return null;

    const lines = rule.lines({
      ordered: Number(event.expectedAmount),
      observed: event.observedAmount === null ? null : Number(event.observedAmount),
      fee: Number(transaction.feeAmount ?? 0),
    });

    if (lines.length === 0) return null;

    const entry = em.getRepository(JournalEntry).create({
      transactionReference: event.transactionReference,
      eventId: event.id,
      eventType: event.eventType,
      narration: rule.narration,
      currency: event.currency,
      correlationId: event.correlationId,
      occurredAt: event.occurredAt,
      lines: lines.map((line) =>
        em.getRepository(JournalLine).create({
          account: line.account,
          direction: line.direction,
          amount: line.amount,
        }),
      ),
    });

    const saved = await em.getRepository(JournalEntry).save(entry);

    this.logger.log({
      event: 'ledger.entry.posted',
      reference: saved.transactionReference,
      eventType: saved.eventType,
      lines: lines.length,
    });

    return saved;
  }

  /** Ecritures d'une transaction, de la plus ancienne a la plus recente. */
  async findByTransaction(transactionReference: string): Promise<JournalEntry[]> {
    return this.entries.find({
      where: { transactionReference },
      order: { occurredAt: 'ASC', createdAt: 'ASC' },
    });
  }

  /**
   * Balance des comptes, sur une transaction ou sur l'ensemble.
   *
   * `difference` doit valoir zero. Une valeur non nulle signalerait qu'une
   * ecriture desequilibree a franchi le declencheur — donc une corruption, pas
   * une erreur de saisie.
   */
  async trialBalance(
    transactionReference?: string,
    requestedCurrency?: string,
  ): Promise<TrialBalance> {
    const currency = requestedCurrency?.trim().toUpperCase() || undefined;
    const currenciesQuery = this.entries
      .createQueryBuilder('entry')
      .select('DISTINCT entry.currency', 'currency');

    if (transactionReference) {
      currenciesQuery.where('entry.transactionReference = :transactionReference', {
        transactionReference,
      });
    }
    if (currency) {
      currenciesQuery.andWhere('entry.currency = :currency', { currency });
    }

    const currencies = (await currenciesQuery.getRawMany<{ currency: string }>()).map(
      (row) => row.currency,
    );

    if (!currency && !transactionReference && currencies.length > 1) {
      throw new BadRequestException(
        'La balance globale doit etre filtree par devise pour ne pas additionner des montants incompatibles',
      );
    }

    const query = this.lines
      .createQueryBuilder('line')
      .innerJoin('line.entry', 'entry')
      .select('line.account', 'account')
      .addSelect('line.direction', 'direction')
      .addSelect('SUM(line.amount)', 'total')
      .groupBy('line.account')
      .addGroupBy('line.direction');

    if (transactionReference) {
      query.where('entry.transactionReference = :transactionReference', { transactionReference });
    }
    if (currency) {
      query.andWhere('entry.currency = :currency', { currency });
    }

    const rows = await query.getRawMany<{
      account: LedgerAccount;
      direction: EntryDirection;
      total: string;
    }>();

    const byAccount = new Map<LedgerAccount, { debits: number; credits: number }>();
    for (const row of rows) {
      const bucket = byAccount.get(row.account) ?? { debits: 0, credits: 0 };
      const amount = Number.parseFloat(row.total);
      if (row.direction === EntryDirection.DEBIT) bucket.debits += amount;
      else bucket.credits += amount;
      byAccount.set(row.account, bucket);
    }

    const accounts = [...byAccount.entries()]
      .map(([account, { debits, credits }]) => ({
        account,
        debits: round(debits),
        credits: round(credits),
        balance: round(balanceOf(account, debits, credits)),
      }))
      .sort((a, b) => a.account.localeCompare(b.account));

    const totalDebits = round(accounts.reduce((sum, a) => sum + a.debits, 0));
    const totalCredits = round(accounts.reduce((sum, a) => sum + a.credits, 0));

    const [{ count } = { count: '0' }] = await this.entries
      .createQueryBuilder('entry')
      .select('COUNT(*)', 'count')
      .where(
        transactionReference ? 'entry.transactionReference = :transactionReference' : '1 = 1',
        { transactionReference },
      )
      .andWhere(currency ? 'entry.currency = :currency' : '1 = 1', { currency })
      .getRawMany<{ count: string }>();

    return {
      accounts,
      totalDebits,
      totalCredits,
      difference: round(totalDebits - totalCredits),
      currency: currency ?? currencies[0] ?? null,
      entryCount: Number.parseInt(count, 10),
    };
  }
}

/** Les montants sont au centime : l'arrondi ferme les residus de flottant. */
const round = (value: number): number => Math.round(value * 100) / 100;
