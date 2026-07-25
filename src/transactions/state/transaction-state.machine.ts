import { Injectable, Logger } from '@nestjs/common';
import type { Transaction } from '../entities/transaction.entity';
import { IllegalTransitionException } from './illegal-transition.exception';
import {
  INVARIANTS,
  TRANSITIONS,
  type StateDimension,
  type TransactionState,
} from './transaction-state';

const DIMENSIONS = Object.keys(TRANSITIONS) as StateDimension[];

/** Reduit une transaction a ses seules dimensions de statut. */
export const stateOf = (transaction: Transaction): TransactionState => ({
  status: transaction.status,
  providerStatus: transaction.providerStatus ?? null,
  bankStatus: transaction.bankStatus ?? null,
  reconciliationStatus: transaction.reconciliationStatus ?? null,
  refundStatus: transaction.refundStatus ?? null,
  caseStatus: transaction.caseStatus ?? null,
  paymentChannel: transaction.paymentChannel,
});

/**
 * Machine a etats des transactions.
 *
 * ## Ce qu'elle encadre
 *
 * 1. **Les transitions** — chaque dimension ne peut evoluer que selon sa table.
 *    Une valeur terminale ne bouge plus.
 * 2. **Les combinaisons** — les invariants ferment les etats que les tables,
 *    qui ne voient qu'une dimension a la fois, laisseraient passer.
 *
 * ## Pourquoi elle importe particulierement ici
 *
 * Le registre est append-only : une transition fautive n'est pas corrigeable,
 * elle est **consignee et scellee**. Un etat impossible ne se rattrape donc pas
 * apres coup — il se constate, et la preuve de sa survenue est publiee avec le
 * reste. La machine est le seul endroit ou l'erreur peut encore etre arretee.
 *
 * ## Ce qu'elle n'encadre pas
 *
 * Elle s'applique aux ecritures passant par la passerelle. Une mise a jour SQL
 * directe l'ignore — c'est le role des contraintes `CHECK` posees en base, qui
 * reprennent les memes invariants. La table de transitions, elle, exige de
 * connaitre l'etat de depart : elle reste applicative.
 */
@Injectable()
export class TransactionStateMachine {
  private readonly logger = new Logger(TransactionStateMachine.name);

  /**
   * Verifie le passage de `before` a `after` et refuse ce qui ne peut pas exister.
   *
   * @throws IllegalTransitionException
   */
  assertTransition(before: TransactionState, after: TransactionState, reference: string): void {
    const violations = [...this.illegalMoves(before, after), ...this.brokenInvariants(after)];

    if (violations.length === 0) return;

    this.logger.error({
      event: 'transaction.transition.refused',
      reference,
      violations,
      before,
      after,
    });

    throw new IllegalTransitionException(reference, violations);
  }

  /** Valide l'etat d'arrivee seul, quand il n'y a pas d'etat de depart. */
  assertInitialState(state: TransactionState, reference: string): void {
    const violations = this.brokenInvariants(state);
    if (violations.length === 0) return;

    this.logger.error({
      event: 'transaction.initial-state.refused',
      reference,
      violations,
      state,
    });

    throw new IllegalTransitionException(reference, violations);
  }

  private illegalMoves(before: TransactionState, after: TransactionState): string[] {
    const violations: string[] = [];

    for (const dimension of DIMENSIONS) {
      const from = before[dimension];
      const to = after[dimension];

      // Reecriture a l'identique, ou dimension non renseignee sur ce canal.
      if (from === to || to === null) continue;

      // Une dimension qui s'initialise depuis l'absence n'est pas une transition :
      // c'est la premiere valeur observee sur ce canal.
      if (from === null) continue;

      const allowed = TRANSITIONS[dimension][from] ?? [];
      if (!allowed.includes(to)) {
        violations.push(
          allowed.length === 0
            ? `${dimension} : ${from} est terminal, passage vers ${to} refuse`
            : `${dimension} : ${from} -> ${to} hors des transitions admises (${allowed.join(', ')})`,
        );
      }
    }

    return violations;
  }

  private brokenInvariants(state: TransactionState): string[] {
    return INVARIANTS.filter((invariant) => !invariant.holds(state)).map(
      (invariant) => `${invariant.name} : ${invariant.because}`,
    );
  }
}
