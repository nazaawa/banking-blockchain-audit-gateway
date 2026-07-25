import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Parser, processors } from 'xml2js';
import { soapConfig } from '../config/configuration';
import { SoapFaultException, SoapParsingException } from './exceptions/soap.exceptions';
import type { SoapFaultDetails } from './soap.types';

const SOAP_12_NAMESPACE = 'http://www.w3.org/2003/05/soap-envelope';

/**
 * Constructions XML refusees avant meme le parsing.
 *
 * - `<!DOCTYPE` / `<!ENTITY` : vecteur XXE et « billion laughs ».
 * - `<?xml-stylesheet` : chargement de ressource externe cote consommateur.
 *
 * xml2js (sax) ne developpe pas les entites externes, mais on rejette en amont
 * plutot que de dependre du comportement par defaut d'une dependance tierce.
 */
const FORBIDDEN_CONSTRUCTS = [/<!DOCTYPE/i, /<!ENTITY/i, /<\?xml-stylesheet/i];

type XmlNode = Record<string, unknown>;

/**
 * Transforme une reponse SOAP brute (XML) en objet metier JSON.
 *
 * Responsabilites :
 *  1. controler l'innocuite du payload (taille, constructions interdites) ;
 *  2. parser l'enveloppe de facon tolerante aux prefixes de namespace ;
 *  3. detecter et normaliser les `<soap:Fault>` (SOAP 1.1 et 1.2) ;
 *  4. extraire la valeur de resultat de l'operation demandee.
 */
@Injectable()
export class SoapResponseMapper {
  private readonly logger = new Logger(SoapResponseMapper.name);

  /**
   * `explicitArray: false` simplifie l'acces aux noeuds uniques.
   * `stripPrefix` rend l'extraction independante du prefixe choisi par le
   * fournisseur (`m:`, `ns1:`, aucun prefixe...).
   */
  private readonly parser = new Parser({
    explicitArray: false,
    explicitRoot: true,
    trim: true,
    ignoreAttrs: false,
    tagNameProcessors: [processors.stripPrefix],
  });

  constructor(
    @Inject(soapConfig.KEY)
    private readonly config: ConfigType<typeof soapConfig>,
  ) {}

  /** Parse une enveloppe SOAP apres controles de securite. */
  async parseEnvelope(xml: string, operation: string): Promise<XmlNode> {
    this.assertSafePayload(xml, operation);

    let parsed: XmlNode;
    try {
      parsed = (await this.parser.parseStringPromise(xml)) as XmlNode;
    } catch (error) {
      throw new SoapParsingException(
        `Reponse XML malformee pour l'operation ${operation}`,
        operation,
        error,
      );
    }

    const envelope = this.asNode(parsed?.['Envelope']);
    if (!envelope) {
      throw new SoapParsingException(
        `Enveloppe SOAP absente dans la reponse de l'operation ${operation}`,
        operation,
      );
    }

    const body = this.asNode(envelope['Body']);
    if (!body) {
      throw new SoapParsingException(
        `Element <Body> absent dans la reponse de l'operation ${operation}`,
        operation,
      );
    }

    return body;
  }

  /**
   * Extrait le resultat d'une operation `document/literal` de la forme
   * `<OperationResponse><OperationResult>...</OperationResult></OperationResponse>`.
   *
   * Leve une `SoapFaultException` si le corps contient une faute.
   */
  async extractOperationResult(xml: string, operation: string): Promise<string> {
    const body = await this.parseEnvelope(xml, operation);

    const fault = this.extractFault(body, xml);
    if (fault) {
      this.logger.warn({
        event: 'soap.fault.received',
        operation,
        faultCode: fault.faultCode,
        soapVersion: fault.soapVersion,
      });
      throw new SoapFaultException(fault, operation, xml);
    }

    const responseNode = this.asNode(body[`${operation}Response`]);
    if (!responseNode) {
      throw new SoapParsingException(
        `Element <${operation}Response> absent de la reponse SOAP`,
        operation,
      );
    }

    const result = responseNode[`${operation}Result`];
    const value = this.asText(result);

    if (value === null) {
      throw new SoapParsingException(
        `Element <${operation}Result> absent ou vide dans la reponse SOAP`,
        operation,
      );
    }

    return value;
  }

  /** Convertit un montant en toutes lettres a partir de la reponse `NumberToDollars`. */
  async mapNumberToDollars(xml: string): Promise<string> {
    return this.extractOperationResult(xml, 'NumberToDollars');
  }

  /** Convertit un entier en toutes lettres a partir de la reponse `NumberToWords`. */
  async mapNumberToWords(xml: string): Promise<string> {
    return this.extractOperationResult(xml, 'NumberToWords');
  }

  /**
   * Normalise un `<soap:Fault>` SOAP 1.1 ou 1.2 vers une structure unique.
   * Retourne `null` si le corps ne contient pas de faute.
   */
  extractFault(body: XmlNode, rawXml = ''): SoapFaultDetails | null {
    // La presence de la balise suffit a qualifier l'echec : un `<soap:Fault/>`
    // vide est parse en chaine vide par xml2js, et doit rester une faute.
    if (!('Fault' in body)) return null;
    const fault = this.asNode(body['Fault']) ?? {};

    const isSoap12 = rawXml.includes(SOAP_12_NAMESPACE) || 'Code' in fault || 'Reason' in fault;

    if (isSoap12) {
      const code = this.asNode(fault['Code']);
      const reason = this.asNode(fault['Reason']);
      const subcode = code ? this.asNode(code['Subcode']) : undefined;

      return {
        soapVersion: '1.2',
        faultCode:
          this.asText(code?.['Value']) ?? this.asText(subcode?.['Value']) ?? 'soap:Receiver',
        faultString:
          this.asText(reason?.['Text']) ??
          this.asText(fault['Reason']) ??
          'Faute SOAP sans motif fourni',
        faultActor: this.asText(fault['Role']) ?? undefined,
        detail: this.stringifyDetail(fault['Detail']),
      };
    }

    return {
      soapVersion: '1.1',
      faultCode: this.asText(fault['faultcode']) ?? 'soap:Server',
      faultString: this.asText(fault['faultstring']) ?? 'Faute SOAP sans motif fourni',
      faultActor: this.asText(fault['faultactor']) ?? undefined,
      detail: this.stringifyDetail(fault['detail']),
    };
  }

  /** Rejette les payloads vides, trop volumineux ou porteurs de constructions dangereuses. */
  private assertSafePayload(xml: string, operation: string): void {
    if (typeof xml !== 'string' || xml.trim().length === 0) {
      throw new SoapParsingException(`Reponse SOAP vide pour l'operation ${operation}`, operation);
    }

    const size = Buffer.byteLength(xml, 'utf8');
    if (size > this.config.maxResponseBytes) {
      throw new SoapParsingException(
        `Reponse SOAP trop volumineuse (${size} octets > ${this.config.maxResponseBytes})`,
        operation,
      );
    }

    for (const pattern of FORBIDDEN_CONSTRUCTS) {
      if (pattern.test(xml)) {
        throw new SoapParsingException(
          `Reponse SOAP rejetee : construction XML interdite detectee (${pattern.source})`,
          operation,
        );
      }
    }
  }

  /**
   * Extrait le texte d'un noeud xml2js.
   *
   * Un element peut etre une chaine, ou un objet `{ _: 'texte', $: {...} }`
   * lorsqu'il porte des attributs (cas frequent de `<Text xml:lang="en">`).
   */
  private asText(node: unknown): string | null {
    if (typeof node === 'string') {
      const trimmed = node.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof node === 'number' || typeof node === 'boolean') return String(node);
    if (Array.isArray(node)) return node.length > 0 ? this.asText(node[0]) : null;
    if (node && typeof node === 'object' && '_' in node) {
      return this.asText(node._);
    }
    return null;
  }

  private asNode(node: unknown): XmlNode | undefined {
    if (Array.isArray(node)) return this.asNode(node[0]);
    if (node && typeof node === 'object') return node as XmlNode;
    return undefined;
  }

  private stringifyDetail(detail: unknown): string | undefined {
    if (detail === undefined || detail === null) return undefined;
    const text = this.asText(detail);
    if (text !== null) return text;
    try {
      return JSON.stringify(detail);
    } catch {
      return undefined;
    }
  }
}
