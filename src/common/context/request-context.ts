import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  /** Identifiant propage de bout en bout : API -> service -> appel SOAP -> audit. */
  correlationId: string;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Execute un traitement dans un contexte de correlation isole. */
export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

/** Contexte courant, ou `undefined` hors requete HTTP (tache planifiee, test...). */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Identifiant de correlation courant. Retourne un identifiant genere a la volee
 * si aucun contexte n'est actif, afin que la journalisation reste correlable.
 */
export function getCorrelationId(): string {
  return storage.getStore()?.correlationId ?? randomUUID();
}
