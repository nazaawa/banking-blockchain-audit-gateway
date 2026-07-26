/**
 * Controle de coherence apres restauration.
 *
 * Confronte l'etat restaure aux preuves publiees sur la chaine et distingue
 * explicitement une perte de donnees d'une alteration — deux diagnostics qui
 * appellent des reactions opposees.
 *
 *   npm run ops:verify-restore
 *
 * Code de sortie non nul si la restauration est incomplete : la commande peut
 * ainsi garder une remise en service automatisee.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { RestoreVerificationService } from '../src/observability/restore-verification.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const report = await app.get(RestoreVerificationService).verify();

    console.log(`\nVerdict            : ${report.verdict}`);
    console.log(`Lots examines      : ${report.batchesExamined}`);
    console.log(`Faits manquants    : ${report.eventsMissing}`);
    console.log(`Lots divergents    : ${report.batchesMismatched}\n`);

    for (const batch of report.batches.filter((entry) => entry.verdict !== 'COMPLETE')) {
      console.log(
        `  ${batch.verdict.padEnd(18)} ${batch.batchId}  ` +
          `publie=${batch.publishedLeafCount ?? '?'} restaure=${batch.restoredLeafCount}`,
      );
    }

    console.log();
    for (const finding of report.findings) console.log(`  ${finding}`);
    console.log();

    process.exitCode = report.verdict === 'CONSISTENT' ? 0 : 1;
  } finally {
    await app.close();
  }
}

void main();
