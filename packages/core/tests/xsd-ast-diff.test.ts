import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeXsdAstDiff,
  extractJavaFieldTypeHints,
  XsdOracleBridge,
  type ExecFileAsyncFn,
} from '../src/oracle/xsd-ast-diff.js';
import type { ExtractJavaAstResult, ExtractXsdResult, OracleRegistryEntry } from '../src/domain/types.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '../../..');
const ORACLE_JAR = path.join(REPO_ROOT, 'tools', 'xsd-oracle', 'target', 'xsd-oracle.jar');
const XSD_SAMPLE_DIR = path.join(REPO_ROOT, 'tools', 'xsd-oracle', 'src', 'test', 'resources', 'xsd-sample');
const NFE_PARSER_DIR = path.join(REPO_ROOT, 'nfe-parser');

const NFE_REGISTRY_ENTRY: OracleRegistryEntry = {
  dfe: 'NFe',
  basePackage: 'br.gov.mg.fazenda.nfeparser',
  domainPackage: 'br.gov.mg.fazenda.nfeparser.nfe',
  mapperPackage: 'br.gov.mg.fazenda.nfeparser.mapper',
  tablePackage: 'br.gov.mg.fazenda.nfeparser.table',
  parserPackage: 'br.gov.mg.fazenda.nfeparser.parser',
  utilPackage: 'br.gov.mg.fazenda.nfeparser.util',
  tagPrefix: 'NFEPROC',
};

describe('XsdOracleBridge & computeXsdAstDiff', () => {
  it('XD-01: extractXsd and extractJavaAst pass safe args and @tempFile without shell', async () => {
    const capturedCalls: Array<{
      file: string;
      args: readonly string[];
      shellOption: unknown;
      tempFileStillExists: boolean;
    }> = [];

    const mockExecFile: ExecFileAsyncFn = async (file, args, options) => {
      const regArgIndex = args.indexOf('--registry-entry');
      let tempExists = false;
      if (regArgIndex >= 0 && args[regArgIndex + 1]?.startsWith('@')) {
        tempExists = existsSync(args[regArgIndex + 1]!.slice(1));
      }
      capturedCalls.push({
        file,
        args,
        shellOption: (options as { shell?: unknown } | undefined)?.shell,
        tempFileStillExists: tempExists,
      });

      if (args.includes('extract-xsd')) {
        return {
          stdout: JSON.stringify({
            rootElements: ['NFEPROC'],
            nodes: [
              {
                tagPath: 'NFEPROC.NFE.INFNFE.IDE.CUF',
                xsdType: 'TCodUF',
                minOccurs: 1,
                maxOccurs: 1,
                isAttribute: false,
              },
            ],
          }),
          stderr: '',
        };
      }

      return {
        stdout: JSON.stringify({
          setterKeys: [
            {
              fullTagPath: 'NFEPROC.NFE.INFNFE.IDE.CUF',
              leafTag: 'CUF',
              mapperClass: 'NfeMapper',
              targetDtoField: 'cUf',
            },
          ],
          jsonProperties: [],
          tableFields: [],
        }),
        stderr: '',
      };
    };

    const bridge = new XsdOracleBridge({
      jarPath: '/opt/tools/xsd-oracle.jar',
      execFileFn: mockExecFile,
    });

    const xsd = await bridge.extractXsd('/tmp/xsds');
    expect(xsd.rootElements).toEqual(['NFEPROC']);

    const ast = await bridge.extractJavaAst('/tmp/nfe-parser', NFE_REGISTRY_ENTRY);
    expect(ast.setterKeys).toHaveLength(1);
    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[0]?.shellOption).toBe(false);
    expect(capturedCalls[1]?.shellOption).toBe(false);
    expect(capturedCalls[1]?.tempFileStillExists).toBe(true);

    const regPath = capturedCalls[1]!.args[capturedCalls[1]!.args.indexOf('--registry-entry') + 1]!.slice(1);
    expect(existsSync(regPath)).toBe(false);
  });

  it('XD-02: validateXml returns structured errors on exit code 1 and throws sanitized error on exit code 2', async () => {
    const mockExecFile: ExecFileAsyncFn = async (_file, args) => {
      const xmlFile = args[args.indexOf('--xml') + 1] ?? '';
      if (xmlFile.endsWith('invalid.xml')) {
        const err = new Error('Command failed') as Error & {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        err.code = 1;
        err.stdout = JSON.stringify({
          valid: false,
          errors: [{ line: 12, column: 8, message: 'cvc-complex-type.2.4.a: Invalid content' }],
        });
        err.stderr = '';
        throw err;
      }

      const fatal = new Error('Fatal failure ghp_secret12345678901234567890') as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      fatal.code = 2;
      fatal.stdout = '';
      fatal.stderr = 'XXE blocked token=Bearer topsecretvalue';
      throw fatal;
    };

    const bridge = new XsdOracleBridge({
      jarPath: '/opt/tools/xsd-oracle.jar',
      execFileFn: mockExecFile,
    });

    const invalidResult = await bridge.validateXml('/tmp/xsds', '/tmp/invalid.xml');
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.errors).toEqual([
      { line: 12, column: 8, message: 'cvc-complex-type.2.4.a: Invalid content' },
    ]);

    await expect(bridge.validateXml('/tmp/xsds', '/tmp/fatal.xml')).rejects.toThrow(/REDACTED/);
  });

  it('XD-03: detects MISSING_TAG on leaf XSD nodes while skipping complexType containers', () => {
    const xsd: ExtractXsdResult = {
      rootElements: ['NFEPROC'],
      nodes: [
        { tagPath: 'NFEPROC', xsdType: 'complexType', minOccurs: 1, maxOccurs: 1, isAttribute: false },
        { tagPath: 'NFEPROC.NFE', xsdType: 'TNFe', minOccurs: 1, maxOccurs: 1, isAttribute: false },
        {
          tagPath: 'NFEPROC.NFE.INFNFE.IDE.CUF',
          xsdType: 'TCodUF',
          minOccurs: 1,
          maxOccurs: 1,
          isAttribute: false,
        },
        {
          tagPath: 'NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VIBSCBS',
          xsdType: 'TDec_1302',
          minOccurs: 0,
          maxOccurs: 1,
          isAttribute: false,
        },
      ],
    };

    const ast: ExtractJavaAstResult = {
      setterKeys: [
        {
          fullTagPath: 'NFEPROC.NFE.INFNFE.IDE.CUF',
          leafTag: 'CUF',
          mapperClass: 'NfeMapper',
          targetDtoField: 'cUf',
        },
      ],
      jsonProperties: [],
      tableFields: [],
    };

    const findings = computeXsdAstDiff({
      xsd,
      ast,
      registryEntry: NFE_REGISTRY_ENTRY,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('MISSING_TAG');
    expect(findings[0]?.tagPath).toBe('NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VIBSCBS');
    expect(findings[0]?.expectedXsdType).toBe('TDec_1302');
  });

  it('XD-04: detects CARDINALITY_MISMATCH and TYPE_MISMATCH from Java DTO field hints', () => {
    const xsd: ExtractXsdResult = {
      rootElements: ['NFEPROC'],
      nodes: [
        {
          tagPath: 'NFEPROC.NFE.INFNFE.DET.PROD.NVE',
          xsdType: 'xs:string',
          minOccurs: 0,
          maxOccurs: 8,
          isAttribute: false,
        },
        {
          tagPath: 'NFEPROC.NFE.INFNFE.DET.PROD.VPROD',
          xsdType: 'TDec_1302',
          minOccurs: 1,
          maxOccurs: 1,
          isAttribute: false,
        },
        {
          tagPath: 'NFEPROC.NFE.INFNFE.IDE.DHEMI',
          xsdType: 'TDateTimeUTC',
          minOccurs: 1,
          maxOccurs: 1,
          isAttribute: false,
        },
      ],
    };

    const ast: ExtractJavaAstResult = {
      setterKeys: [
        {
          fullTagPath: 'NFEPROC.NFE.INFNFE.DET.PROD.NVE',
          leafTag: 'NVE',
          mapperClass: 'ItemMapper',
          targetDtoField: 'nve',
        },
        {
          fullTagPath: 'NFEPROC.NFE.INFNFE.DET.PROD.VPROD',
          leafTag: 'VPROD',
          mapperClass: 'ItemMapper',
          targetDtoField: 'vprod',
        },
        {
          fullTagPath: 'NFEPROC.NFE.INFNFE.IDE.DHEMI',
          leafTag: 'DHEMI',
          mapperClass: 'NfeMapper',
          targetDtoField: 'dhEmi',
        },
      ],
      jsonProperties: [],
      tableFields: [],
    };

    const findings = computeXsdAstDiff({
      xsd,
      ast,
      registryEntry: NFE_REGISTRY_ENTRY,
      fieldTypes: {
        byClassField: new Map([
          ['Item.nve', 'String'],
          ['Item.vprod', 'String'],
          ['Nfe.dhEmi', 'Integer'],
        ]),
        byField: new Map(),
      },
    });

    expect(findings.map((f) => `${f.kind}:${f.tagPath}`).sort()).toEqual([
      'CARDINALITY_MISMATCH:NFEPROC.NFE.INFNFE.DET.PROD.NVE',
      'TYPE_MISMATCH:NFEPROC.NFE.INFNFE.DET.PROD.VPROD',
      'TYPE_MISMATCH:NFEPROC.NFE.INFNFE.IDE.DHEMI',
    ]);
  });

  it('XD-05: supports NFCe NFEPROC tagPrefix and Tier 2 mapper matches (PisMapper, IcmsMapper, NveMapper)', () => {
    const nfceRegistry: OracleRegistryEntry = {
      dfe: 'NFCe',
      basePackage: 'br.gov.mg.fazenda.nfceparser',
      domainPackage: 'br.gov.mg.fazenda.nfceparser.nfce',
      mapperPackage: 'br.gov.mg.fazenda.nfceparser.mapper',
      tablePackage: 'br.gov.mg.fazenda.nfceparser.table',
      parserPackage: 'br.gov.mg.fazenda.nfceparser.parser',
      utilPackage: 'br.gov.mg.fazenda.nfceparser.util',
      tagPrefix: 'NFEPROC',
    };

    const xsd: ExtractXsdResult = {
      rootElements: ['NFEPROC'],
      nodes: [
        { tagPath: 'NFEPROC.NFE.INFNFE.DET.PROD.NVE', xsdType: 'xs:string', minOccurs: 0, maxOccurs: 8, isAttribute: false },
        { tagPath: 'NFEPROC.NFE.INFNFE.DET.IMPOSTO.PIS.PISALIQ.VPIS', xsdType: 'TDec_1302', minOccurs: 1, maxOccurs: 1, isAttribute: false },
        { tagPath: 'NFEPROC.NFE.INFNFE.DET.IMPOSTO.ICMS.ICMS00.ORIG', xsdType: 'xs:string', minOccurs: 1, maxOccurs: 1, isAttribute: false },
      ],
    };

    const ast: ExtractJavaAstResult = {
      setterKeys: [
        { fullTagPath: 'NFEPROC.NFE.INFNFE.DET.NVE', leafTag: 'NVE', mapperClass: 'NveMapper', targetDtoField: 'nve' },
        { fullTagPath: 'NFEPROC.NFE.INFNFE.DET.IMPOSTO.PIS.VPIS', leafTag: 'VPIS', mapperClass: 'PisMapper', targetDtoField: 'vpis' },
        { fullTagPath: 'NFEPROC.NFE.INFNFE.DET.ICMS.ORIG', leafTag: 'ORIG', mapperClass: 'IcmsMapper', targetDtoField: 'orig' },
      ],
      jsonProperties: [],
      tableFields: [],
    };

    const findings = computeXsdAstDiff({
      xsd,
      ast,
      registryEntry: nfceRegistry,
      fieldTypes: {
        byClassField: new Map([
          ['Nve.nve', 'List<String>'],
          ['Pis.vpis', 'BigDecimal'],
          ['Icms.orig', 'String'],
        ]),
        byField: new Map(),
      },
    });

    expect(findings).toEqual([]);
  });

  it('XD-06: real xsd-oracle.jar + nfe-parser integration runs extractXsd, extractJavaAst, validateXml, and diff', async () => {
    const bridge = new XsdOracleBridge({ jarPath: ORACLE_JAR });

    const [xsd, ast, fieldTypes, validResult, invalidResult] = await Promise.all([
      bridge.extractXsd(XSD_SAMPLE_DIR),
      bridge.extractJavaAst(NFE_PARSER_DIR, NFE_REGISTRY_ENTRY),
      extractJavaFieldTypeHints(NFE_PARSER_DIR, NFE_REGISTRY_ENTRY.domainPackage),
      bridge.validateXml(XSD_SAMPLE_DIR, path.join(XSD_SAMPLE_DIR, 'valid_nfe.xml')),
      bridge.validateXml(XSD_SAMPLE_DIR, path.join(XSD_SAMPLE_DIR, 'invalid_nfe.xml')),
    ]);

    expect(validResult.valid).toBe(true);
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.errors.length).toBeGreaterThan(0);

    expect(fieldTypes.byClassField.get('Item.vprod')).toBe('BigDecimal');
    expect(fieldTypes.byClassField.get('Item.nve')).toBe('List<String>');

    const findings = computeXsdAstDiff({
      xsd,
      ast,
      registryEntry: NFE_REGISTRY_ENTRY,
      fieldTypes,
    });

    const missingPaths = new Set(findings.filter((f) => f.kind === 'MISSING_TAG').map((f) => f.tagPath));
    expect(missingPaths.has('NFEPROC.NFE.INFNFE.DET.PROD.NVE')).toBe(false);
    expect(missingPaths.has('NFEPROC.NFE.INFNFE.DET.IMPOSTO.PIS.PISALIQ.VPIS')).toBe(false);
    expect(missingPaths.has('NFEPROC.NFE.INFNFE.DET.IMPOSTO.ICMS.ICMS00.ORIG')).toBe(false);

    const vprodTypeMismatch = findings.find(
      (f) => f.tagPath === 'NFEPROC.NFE.INFNFE.DET.PROD.VPROD' && f.kind === 'TYPE_MISMATCH',
    );
    expect(vprodTypeMismatch).toBeUndefined();
  }, 30_000);
});
