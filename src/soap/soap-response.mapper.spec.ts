import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigType } from '@nestjs/config';
import type { soapConfig } from '../config/configuration';
import { SoapFaultException, SoapParsingException } from './exceptions/soap.exceptions';
import { SoapResponseMapper } from './soap-response.mapper';

const SAMPLES_DIR = join(__dirname, '..', '..', 'samples');
const sample = (name: string): string => readFileSync(join(SAMPLES_DIR, name), 'utf8');

const config = {
  maxResponseBytes: 1_048_576,
} as ConfigType<typeof soapConfig>;

describe('SoapResponseMapper', () => {
  let mapper: SoapResponseMapper;

  beforeEach(() => {
    mapper = new SoapResponseMapper(config);
  });

  describe('reponse nominale', () => {
    it('extrait le montant en toutes lettres d une reponse reelle du fournisseur', async () => {
      const result = await mapper.mapNumberToDollars(sample('soap-response.xml'));

      expect(result).toBe('one thousand two hundred and fifty dollars and seventy five cents');
    });

    it('accepte une enveloppe sans prefixe de namespace', async () => {
      const xml = `<?xml version="1.0"?>
        <Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
          <Body>
            <NumberToDollarsResponse xmlns="http://www.dataaccess.com/webservicesserver/">
              <NumberToDollarsResult>ten dollars</NumberToDollarsResult>
            </NumberToDollarsResponse>
          </Body>
        </Envelope>`;

      await expect(mapper.mapNumberToDollars(xml)).resolves.toBe('ten dollars');
    });

    it('accepte un prefixe de namespace arbitraire', async () => {
      const xml = `<?xml version="1.0"?>
        <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
          <s:Body>
            <ns7:NumberToDollarsResponse xmlns:ns7="http://www.dataaccess.com/webservicesserver/">
              <ns7:NumberToDollarsResult>ten dollars</ns7:NumberToDollarsResult>
            </ns7:NumberToDollarsResponse>
          </s:Body>
        </s:Envelope>`;

      await expect(mapper.mapNumberToDollars(xml)).resolves.toBe('ten dollars');
    });

    it('gere l operation NumberToWords', async () => {
      const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <m:NumberToWordsResponse xmlns:m="http://www.dataaccess.com/webservicesserver/">
              <m:NumberToWordsResult>one thousand two hundred and fifty </m:NumberToWordsResult>
            </m:NumberToWordsResponse>
          </soap:Body>
        </soap:Envelope>`;

      await expect(mapper.mapNumberToWords(xml)).resolves.toBe(
        'one thousand two hundred and fifty',
      );
    });
  });

  describe('fautes SOAP', () => {
    it('normalise une faute SOAP 1.1', async () => {
      expect.assertions(5);

      try {
        await mapper.mapNumberToDollars(sample('soap-fault.xml'));
      } catch (error) {
        expect(error).toBeInstanceOf(SoapFaultException);
        const fault = (error as SoapFaultException).fault;
        expect(fault.soapVersion).toBe('1.1');
        expect(fault.faultCode).toBe('soap:Server');
        expect(fault.faultString).toContain('Server was unable to process request');
        expect(fault.faultActor).toContain('NumberConversion.wso');
      }
    });

    it('normalise une faute SOAP 1.2 vers la meme structure', async () => {
      expect.assertions(4);

      try {
        await mapper.mapNumberToDollars(sample('soap-fault-12.xml'));
      } catch (error) {
        expect(error).toBeInstanceOf(SoapFaultException);
        const fault = (error as SoapFaultException).fault;
        expect(fault.soapVersion).toBe('1.2');
        expect(fault.faultCode).toBe('soap:Sender');
        // <Text xml:lang="en"> porte un attribut : xml2js expose le texte sous `_`.
        expect(fault.faultString).toBe('Value was either too large or too small for a Decimal.');
      }
    });

    it('conserve l XML brut de la faute pour la piste d audit', async () => {
      expect.assertions(1);

      try {
        await mapper.mapNumberToDollars(sample('soap-fault.xml'));
      } catch (error) {
        expect((error as SoapFaultException).rawResponse).toContain('<faultcode>');
      }
    });

    it('remonte une faute meme si les champs de motif sont absents', async () => {
      const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body><soap:Fault></soap:Fault></soap:Body>
        </soap:Envelope>`;

      await expect(mapper.mapNumberToDollars(xml)).rejects.toBeInstanceOf(SoapFaultException);
    });
  });

  describe('securite du parseur', () => {
    it('rejette un document declarant une entite externe (XXE)', async () => {
      await expect(mapper.mapNumberToDollars(sample('soap-response-xxe.xml'))).rejects.toThrow(
        SoapParsingException,
      );
    });

    it('rejette une bombe a entites (billion laughs)', async () => {
      const bomb = `<?xml version="1.0"?>
        <!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body><x>&lol2;</x></soap:Body>
        </soap:Envelope>`;

      await expect(mapper.mapNumberToDollars(bomb)).rejects.toThrow(SoapParsingException);
    });

    it('rejette une instruction de traitement xml-stylesheet', async () => {
      const xml = `<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="http://evil.example/x.xsl"?>
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body/></soap:Envelope>`;

      await expect(mapper.mapNumberToDollars(xml)).rejects.toThrow(SoapParsingException);
    });

    it('rejette une reponse depassant la taille maximale configuree', async () => {
      const restrictive = new SoapResponseMapper({
        maxResponseBytes: 128,
      } as ConfigType<typeof soapConfig>);

      await expect(restrictive.mapNumberToDollars(sample('soap-response.xml'))).rejects.toThrow(
        /trop volumineuse/,
      );
    });
  });

  describe('reponses inexploitables', () => {
    it.each([
      ['chaine vide', ''],
      ['espaces seuls', '   '],
    ])('rejette une reponse %s', async (_cas, xml) => {
      await expect(mapper.mapNumberToDollars(xml)).rejects.toThrow(SoapParsingException);
    });

    it('rejette un XML malforme', async () => {
      await expect(mapper.mapNumberToDollars('<soap:Envelope><soap:Body>')).rejects.toThrow(
        SoapParsingException,
      );
    });

    it('rejette un document sans enveloppe SOAP', async () => {
      await expect(mapper.mapNumberToDollars('<html><body>503</body></html>')).rejects.toThrow(
        /Enveloppe SOAP absente/,
      );
    });

    it('rejette une enveloppe sans Body', async () => {
      const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Header/>
        </soap:Envelope>`;

      await expect(mapper.mapNumberToDollars(xml)).rejects.toThrow(/<Body> absent/);
    });

    it('rejette un corps sans element de reponse attendu', async () => {
      const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body><AutreChoseResponse><Resultat>42</Resultat></AutreChoseResponse></soap:Body>
        </soap:Envelope>`;

      await expect(mapper.mapNumberToDollars(xml)).rejects.toThrow(
        /<NumberToDollarsResponse> absent/,
      );
    });

    it('rejette un element de resultat vide', async () => {
      const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <NumberToDollarsResponse><NumberToDollarsResult></NumberToDollarsResult></NumberToDollarsResponse>
          </soap:Body>
        </soap:Envelope>`;

      await expect(mapper.mapNumberToDollars(xml)).rejects.toThrow(
        /<NumberToDollarsResult> absent ou vide/,
      );
    });
  });

  describe('extractFault', () => {
    it('retourne null pour un corps sans faute', async () => {
      const body = await mapper.parseEnvelope(sample('soap-response.xml'), 'NumberToDollars');
      expect(mapper.extractFault(body)).toBeNull();
    });
  });
});
