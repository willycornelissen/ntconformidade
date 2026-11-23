package br.gov.mg.fazenda.ntc;

import br.gov.mg.fazenda.ntc.model.OracleDtos.ExtractJavaAstResult;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ExtractXsdResult;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ValidateXmlResult;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class XsdOracleMainTest {

    private static final Path SAMPLE_DIR = Paths.get("src", "test", "resources", "xsd-sample");
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void cliExtractXsdOutputsJsonAndExit0() throws IOException {
        RunOutput res = run("extract-xsd", "--xsd-dir", SAMPLE_DIR.toString());
        assertEquals(0, res.exitCode);

        ExtractXsdResult parsed = mapper.readValue(res.stdout, ExtractXsdResult.class);
        assertTrue(parsed.getRootElements().contains("NFEPROC"));
        assertTrue(res.stdout.contains("\"isAttribute\":true"));
    }

    @Test
    void cliValidateXmlReturns0ForValidAnd1ForInvalid() throws IOException {
        RunOutput valid = run(
                "validate-xml",
                "--xsd-dir", SAMPLE_DIR.toString(),
                "--xml", SAMPLE_DIR.resolve("valid_nfe.xml").toString());
        assertEquals(0, valid.exitCode);
        ValidateXmlResult validJson = mapper.readValue(valid.stdout, ValidateXmlResult.class);
        assertTrue(validJson.isValid());

        RunOutput invalid = run(
                "validate-xml",
                "--xsd-dir", SAMPLE_DIR.toString(),
                "--xml", SAMPLE_DIR.resolve("invalid_nfe.xml").toString());
        assertEquals(1, invalid.exitCode);
        ValidateXmlResult invalidJson = mapper.readValue(invalid.stdout, ValidateXmlResult.class);
        assertFalse(invalidJson.isValid());
        assertFalse(invalidJson.getErrors().isEmpty());
    }

    @Test
    void cliExtractJavaAstAcceptsInlineJsonAndFileRegistry(@TempDir Path dir) throws IOException {
        Path pkgDir = dir.resolve("src/main/java/br/gov/mg/fazenda/nfeparser");
        Files.createDirectories(pkgDir.resolve("nfe"));
        Files.createDirectories(pkgDir.resolve("mapper"));
        Files.write(
                pkgDir.resolve("nfe/Nfe.java"),
                "package br.gov.mg.fazenda.nfeparser.nfe;\npublic class Nfe { private Integer cuf; }\n"
                        .getBytes(StandardCharsets.UTF_8));
        Files.write(
                pkgDir.resolve("mapper/NfeMapper.java"),
                ("package br.gov.mg.fazenda.nfeparser.mapper;\n"
                        + "import br.gov.mg.fazenda.nfeparser.nfe.Nfe;\n"
                        + "import java.util.*; import java.util.function.BiConsumer;\n"
                        + "public class NfeMapper {\n"
                        + "  private static final Map<String, BiConsumer<Nfe, String>> M = new HashMap<>();\n"
                        + "  static { M.put(\"NFEPROC.NFE.INFNFE.IDE.CUF\", (n, v) -> n.setCuf(null)); }\n"
                        + "}\n").getBytes(StandardCharsets.UTF_8));

        String regJson = "{\"dfe\":\"NFe\",\"basePackage\":\"br.gov.mg.fazenda.nfeparser\","
                + "\"domainPackage\":\"br.gov.mg.fazenda.nfeparser.nfe\","
                + "\"mapperPackage\":\"br.gov.mg.fazenda.nfeparser.mapper\","
                + "\"tablePackage\":\"br.gov.mg.fazenda.nfeparser.table\","
                + "\"parserPackage\":\"br.gov.mg.fazenda.nfeparser.parser\","
                + "\"tagPrefix\":\"NFEPROC\"}";

        RunOutput inlineRes = run("extract-java-ast", "--repo-dir", dir.toString(), "--registry-entry", regJson);
        assertEquals(0, inlineRes.exitCode);
        ExtractJavaAstResult ast = mapper.readValue(inlineRes.stdout, ExtractJavaAstResult.class);
        assertFalse(ast.getSetterKeys().isEmpty());

        Path regFile = dir.resolve("reg.json");
        Files.write(regFile, regJson.getBytes(StandardCharsets.UTF_8));
        RunOutput fileRes = run("extract-java-ast", "--repo-dir", dir.toString(), "--registry-entry", "@" + regFile);
        assertEquals(0, fileRes.exitCode);
    }

    @Test
    void cliReturns2OnMissingArgsOrUnknownCommand() {
        assertEquals(2, run().exitCode);
        assertEquals(2, run("unknown-cmd").exitCode);
        assertEquals(2, run("extract-xsd").exitCode);
        assertEquals(2, run("extract-xsd", "--xsd-dir", "   ").exitCode);
        assertEquals(2, run("extract-xsd", "--xsd-dir", "dir-inexistente").exitCode);
        assertEquals(2, run("extract-xsd", "no-dash").exitCode);
        assertEquals(2, run("validate-xml", "--xsd-dir", SAMPLE_DIR.toString()).exitCode);
        assertEquals(2, run("extract-java-ast", "--repo-dir", ".").exitCode);
        assertEquals(2, run("extract-java-ast", "--repo-dir", ".", "--registry-entry", "{bad").exitCode);
        assertEquals(2, run("extract-java-ast", "--repo-dir", ".", "--registry-entry", "@nao-existe.json").exitCode);
        assertEquals(2, run("extract-xsd", "--xsd-dir", SAMPLE_DIR.toString(), "--xsd-dir", SAMPLE_DIR.toString()).exitCode);
    }

    private static RunOutput run(String... args) {
        ByteArrayOutputStream outBytes = new ByteArrayOutputStream();
        ByteArrayOutputStream errBytes = new ByteArrayOutputStream();
        int code = XsdOracleMain.execute(
                args,
                new PrintStream(outBytes),
                new PrintStream(errBytes));
        return new RunOutput(
                code,
                new String(outBytes.toByteArray(), StandardCharsets.UTF_8),
                new String(errBytes.toByteArray(), StandardCharsets.UTF_8));
    }

    private static final class RunOutput {
        private final int exitCode;
        private final String stdout;
        private final String stderr;

        private RunOutput(int exitCode, String stdout, String stderr) {
            this.exitCode = exitCode;
            this.stdout = stdout;
            this.stderr = stderr;
        }
    }
}
