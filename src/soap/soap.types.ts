/** Detail normalise d'une faute SOAP, quelle que soit la version (1.1 ou 1.2). */
export interface SoapFaultDetails {
  /** `faultcode` (SOAP 1.1) ou `Code/Value` (SOAP 1.2). */
  faultCode: string;
  /** `faultstring` (SOAP 1.1) ou `Reason/Text` (SOAP 1.2). */
  faultString: string;
  /** `faultactor` / `Role`, si present. */
  faultActor?: string;
  /** Contenu brut de `detail` serialise en texte, si present. */
  detail?: string;
  /** Version detectee de l'enveloppe. */
  soapVersion: '1.1' | '1.2';
}

/** Trace complete d'un aller-retour SOAP, utilisee pour l'audit. */
export interface SoapExchange {
  operation: string;
  endpoint: string;
  /** XML brut emis (non masque : le masquage est applique a la journalisation). */
  rawRequest: string;
  /** XML brut recu. */
  rawResponse: string;
  durationMs: number;
  attempts: number;
}

/** Resultat metier de l'operation NumberToDollars. */
export interface AmountInWordsResult {
  amountInWords: string;
  exchange: SoapExchange;
}

export const SOAP_OPERATIONS = {
  numberToDollars: 'NumberToDollars',
  numberToWords: 'NumberToWords',
} as const;

export type SoapOperation = (typeof SOAP_OPERATIONS)[keyof typeof SOAP_OPERATIONS];
