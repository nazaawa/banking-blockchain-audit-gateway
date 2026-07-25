import { Module } from '@nestjs/common';
import { TransferXmlBuilder } from './transfer-xml.builder';
import { XsdValidatorService } from './xsd-validator.service';

/** Serialisation canonique des documents metier et validation contre les XSD. */
@Module({
  providers: [TransferXmlBuilder, XsdValidatorService],
  exports: [TransferXmlBuilder, XsdValidatorService],
})
export class XmlModule {}
