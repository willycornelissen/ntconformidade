package br.gov.mg.fazenda.ntc;

import br.gov.mg.fazenda.ntc.model.OracleDtos.ValidateXmlResult;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class XsdOracleCliProcessIT {

    private static final Path JAR_PATH = Paths.get("target", "xsd-oracle.jar");
    private static final Path SAMPLE_DIR = Paths.get("src", "test", "resources", "xsd-sample");
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void fatJarExecutesWithExpectedExitCodes() throws Exception {
        assertTrue(Files.isRegularFile(JAR_PATH), "xsd-oracle.jar deve existir na fase verify");

        ProcessOutput valid = runJar(
                "validate-xml",
                "--xsd-dir", SAMPLE_DIR.toString(),
                "--xml", SAMPLE_DIR.resolve("valid_nfe.xml").toString());
        assertEquals(0, valid.exitCode);
        assertTrue(mapper.readValue(valid.stdout, ValidateXmlResult.class).isValid());

        ProcessOutput invalid = runJar(
                "validate-xml",
                "--xsd-dir", SAMPLE_DIR.toString(),
                "--xml", SAMPLE_DIR.resolve("invalid_nfe.xml").toString());
        assertEquals(1, invalid.exitCode);
        assertFalse(mapper.readValue(invalid.stdout, ValidateXmlResult.class).isValid());

        ProcessOutput usageError = runJar("invalid-command");
        assertEquals(2, usageError.exitCode);
    }

    private static ProcessOutput runJar(String... cliArgs) throws IOException, InterruptedException {
        String javaBin = Paths.get(System.getProperty("java.home"), "bin", "java").toString();
        List<String> cmd = new ArrayList<>();
        cmd.add(javaBin);
        cmd.add("-jar");
        cmd.add(JAR_PATH.toString());
        cmd.addAll(Arrays.asList(cliArgs));

        Process process = new ProcessBuilder(cmd).start();
        String stdout = readAll(process.getInputStream());
        String stderr = readAll(process.getErrorStream());
        int code = process.waitFor();
        return new ProcessOutput(code, stdout, stderr);
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) >= 0) {
            out.write(buf, 0, n);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static final class ProcessOutput {
        private final int exitCode;
        private final String stdout;
        private final String stderr;

        private ProcessOutput(int exitCode, String stdout, String stderr) {
            this.exitCode = exitCode;
            this.stdout = stdout;
            this.stderr = stderr;
        }
    }
}
