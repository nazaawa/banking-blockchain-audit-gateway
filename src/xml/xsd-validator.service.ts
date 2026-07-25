import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateXML } from 'xmllint-wasm';
import { XsdSchemaNotFoundException, XsdValidationException } from './exceptions/xml.exceptions';
import type { XsdViolation } from './exceptions/xml.exceptions';

export const SCHEMAS = {
  transferRequest: 'transfer-request.xsd',
  transferRecord: 'transfer-record.xsd',
  transferResponse: 'transfer-response.xsd',
} as const;

export type SchemaName = (typeof SCHEMAS)[keyof typeof SCHEMAS];

/**
 * Validation des documents XML contre leurs schemas XSD.
 *
 * S'appuie sur `xmllint-wasm` : c'est libxml2 compile en WebAssembly, donc le
 * meme moteur de validation que l'outil `xmllint` de reference, sans dependance
 * native a compiler ni JVM a installer. L'image Docker reste identique au poste
 * de developpement.
 *
 * Les schemas sont lus une seule fois et gardes en memoire : la validation est
 * sur le chemin critique de chaque virement.
 */
@Injectable()
export class XsdValidatorService {
  private readonly logger = new Logger(XsdValidatorService.name);
  private readonly cache = new Map<string, string>();
  private readonly schemaDir: string;

  constructor() {
    this.schemaDir = this.resolveSchemaDir();
    this.logger.log({ event: 'xsd.schemas.directory', path: this.schemaDir });
  }

  /**
   * Valide un document et leve une exception detaillee en cas de non-conformite.
   *
   * @throws XsdValidationException  document non conforme
   * @throws XsdSchemaNotFoundException schema absent du deploiement
   */
  async assertValid(xml: string, schemaName: SchemaName): Promise<void> {
    const violations = await this.validate(xml, schemaName);
    if (violations.length > 0) {
      throw new XsdValidationException(schemaName, violations);
    }
  }

  /** Retourne la liste des violations, vide si le document est conforme. */
  async validate(xml: string, schemaName: SchemaName): Promise<XsdViolation[]> {
    const schema = this.loadSchema(schemaName);

    const result = await validateXML({
      xml: [{ fileName: schemaName.replace('.xsd', '.xml'), contents: xml }],
      schema: [schema],
    });

    if (result.valid) return [];

    return result.errors.map((error) => ({
      line: error.loc?.lineNumber,
      // libxml2 prefixe ses messages du nom de fichier : on ne garde que l'utile.
      message: error.message.replace(/^.*?:\d+:\s*/, '').trim(),
    }));
  }

  /** Indique si tous les schemas attendus sont presents (sonde de sante). */
  isReady(): boolean {
    return Object.values(SCHEMAS).every((name) => existsSync(join(this.schemaDir, name)));
  }

  private loadSchema(schemaName: SchemaName): string {
    const cached = this.cache.get(schemaName);
    if (cached !== undefined) return cached;

    const path = join(this.schemaDir, schemaName);
    if (!existsSync(path)) {
      throw new XsdSchemaNotFoundException(schemaName, this.schemaDir);
    }

    const contents = readFileSync(path, 'utf8');
    this.cache.set(schemaName, contents);
    return contents;
  }

  /**
   * Le dossier `schemas/` vit a la racine du depot, hors de `src/`.
   * `../../schemas` resout correctement depuis `src/xml` comme depuis `dist/xml`.
   */
  private resolveSchemaDir(): string {
    const candidates = [
      process.env.XSD_SCHEMA_DIR,
      join(__dirname, '..', '..', 'schemas'),
      join(process.cwd(), 'schemas'),
    ].filter((candidate): candidate is string => Boolean(candidate));

    const found = candidates.find((candidate) =>
      existsSync(join(candidate, SCHEMAS.transferRecord)),
    );

    if (!found) {
      throw new XsdSchemaNotFoundException(SCHEMAS.transferRecord, candidates.join(', '));
    }

    return found;
  }
}
