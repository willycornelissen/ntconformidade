package br.gov.mg.fazenda.ntc;

import br.gov.mg.fazenda.ntc.model.OracleCliException;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ValidateXmlResult;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ValidationError;
import br.gov.mg.fazenda.ntc.xsd.XsdXmlValidator;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class XmlValidatorTest {

    private static final Path SAMPLE_DIR = Paths.get("src", "test", "resources", "xsd-sample");
    private final XsdXmlValidator validator = new XsdXmlValidator();
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void val01AcceptsValidSyntheticXmlAgainstMultiFileXsd() {
        ValidateXmlResult result = validator.validate(
                SAMPLE_DIR,
                SAMPLE_DIR.resolve("valid_nfe.xml"));

        assertTrue(result.isValid());
        assertTrue(result.getErrors().isEmpty());
    }

    @Test
    void val02And03And04CollectsMultipleSchemaErrorsWithLineAndColumn() {
        ValidateXmlResult result = validator.validate(
                SAMPLE_DIR,
                SAMPLE_DIR.resolve("invalid_nfe.xml"));

        assertFalse(result.isValid());
        assertTrue(result.getErrors().size() >= 2, "Deve acumular múltiplos erros");
        for (ValidationError error : result.getErrors()) {
            assertTrue(error.getLine() > 0);
            assertTrue(error.getColumn() > 0);
            assertFalse(error.getMessage().isEmpty());
        }
    }

    @Test
    void val05CapturesMalformedXmlFatalError(@TempDir Path dir) throws IOException {
        Path xml = dir.resolve("malformed.xml");
        Files.write(
                xml,
                "<nfeProc xmlns='http://www.portalfiscal.inf.br/nfe'><NFe></nfeProc>"
                        .getBytes(StandardCharsets.UTF_8));

        ValidateXmlResult result = validator.validate(SAMPLE_DIR, xml);

        assertFalse(result.isValid());
        assertFalse(result.getErrors().isEmpty());
        assertTrue(result.getErrors().get(0).getLine() > 0);
    }

    @Test
    void val06BlocksDtdAndXxePayloadWithoutLeakingFileContent(@TempDir Path dir) throws IOException {
        String canary = "SECRET_CANARY_TOKEN_98765";
        Path secretFile = dir.resolve("secret.txt");
        Files.write(secretFile, canary.getBytes(StandardCharsets.UTF_8));

        Path xml = dir.resolve("xxe.xml");
        Files.write(
                xml,
                ("<!DOCTYPE nfeProc [ <!ENTITY secret SYSTEM '" + secretFile.toUri() + "'> ]>\n"
                        + "<nfeProc xmlns='http://www.portalfiscal.inf.br/nfe'>&secret;</nfeProc>\n")
                        .getBytes(StandardCharsets.UTF_8));

        ValidateXmlResult result = validator.validate(SAMPLE_DIR, xml);

        assertFalse(result.isValid());
        assertFalse(result.getErrors().isEmpty());
        assertTrue(result.getErrors().stream().noneMatch(e -> e.getMessage().contains(canary)));
        assertTrue(result.getErrors().stream().anyMatch(e -> e.getMessage().contains("DOCTYPE")));
    }

    @Test
    void val07ProducesValidJsonForErrorsWithQuotesAndBackslashes(@TempDir Path dir) throws IOException {
        Path xml = dir.resolve("quotes.xml");
        Files.write(
                xml,
                ("<nfeProc xmlns='http://www.portalfiscal.inf.br/nfe' versao='\"\\bad'>\n"
                        + "</nfeProc>\n").getBytes(StandardCharsets.UTF_8));

        ValidateXmlResult result = validator.validate(SAMPLE_DIR, xml);
        assertFalse(result.isValid());

        String json = mapper.writeValueAsString(result);
        ValidateXmlResult reparsed = mapper.readValue(json, ValidateXmlResult.class);
        assertFalse(reparsed.isValid());
    }

    @Test
    void val08RejectsMissingXmlOrInvalidXsdDir(@TempDir Path dir) {
        OracleCliException missingXml = assertThrows(
                OracleCliException.class,
                () -> validator.validate(SAMPLE_DIR, dir.resolve("nao-existe.xml")));
        assertEquals(2, missingXml.getExitCode());

        OracleCliException missingDir = assertThrows(
                OracleCliException.class,
                () -> validator.validate(dir.resolve("nao-existe"), SAMPLE_DIR.resolve("valid_nfe.xml")));
        assertEquals(2, missingDir.getExitCode());

        OracleCliException dirAsXml = assertThrows(
                OracleCliException.class,
                () -> validator.validate(SAMPLE_DIR, dir));
        assertEquals(2, dirAsXml.getExitCode());
    }

    @Test
    void val09CapsExcessiveValidationErrorsAt500(@TempDir Path dir) throws IOException {
        StringBuilder xml = new StringBuilder();
        xml.append("<nfeProc xmlns='http://www.portalfiscal.inf.br/nfe' versao='4.00'>\n");
        xml.append("  <NFe><infNFe versao='4.00' Id='NFe31250112345678000199550010000000011000000010'>\n");
        xml.append("    <ide><cUF>31</cUF><natOp>VENDA</natOp></ide>\n");
        xml.append("    <emit><CNPJ>12345678000199</CNPJ></emit>\n");
        for (int i = 1; i <= 600; i++) {
            xml.append("    <det nItem='").append(i).append("'><prod><cProd>001</cProd><vProd>NAO_NUM</vProd></prod>"
                    + "<imposto><ICMS><ICMS00><orig>0</orig><CST>00</CST></ICMS00></ICMS></imposto></det>\n");
        }
        xml.append("    <total><ICMSTot><vNF>100.00</vNF></ICMSTot></total>\n");
        xml.append("  </infNFe></NFe>\n");
        xml.append("  <protNFe><infProt><nProt>131250000000001</nProt></infProt></protNFe>\n");
        xml.append("</nfeProc>\n");
        Path manyErrorsXml = dir.resolve("many-errors.xml");
        Files.write(manyErrorsXml, xml.toString().getBytes(StandardCharsets.UTF_8));

        ValidateXmlResult result = validator.validate(SAMPLE_DIR, manyErrorsXml);

        assertFalse(result.isValid());
        assertEquals(500, result.getErrors().size());
    }

    @Test
    void val10RejectsXmlSymlink(@TempDir Path dir) throws IOException {
        Path link = dir.resolve("xml-link.xml");
        Files.createSymbolicLink(link, SAMPLE_DIR.resolve("valid_nfe.xml").toAbsolutePath());
        assertEquals(2, assertThrows(OracleCliException.class, () -> validator.validate(SAMPLE_DIR, link)).getExitCode());
    }
}
