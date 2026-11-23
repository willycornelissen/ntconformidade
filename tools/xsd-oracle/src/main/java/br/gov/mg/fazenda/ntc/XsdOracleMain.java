package br.gov.mg.fazenda.ntc;

import br.gov.mg.fazenda.ntc.ast.JavaAstExtractor;
import br.gov.mg.fazenda.ntc.model.OracleCliException;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ExtractJavaAstResult;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ExtractXsdResult;
import br.gov.mg.fazenda.ntc.model.OracleDtos.RegistryEntry;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ValidateXmlResult;
import br.gov.mg.fazenda.ntc.xsd.XsdSchemaExtractor;
import br.gov.mg.fazenda.ntc.xsd.XsdXmlValidator;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.PrintStream;
import java.io.UnsupportedEncodingException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Entrypoint CLI e runner testável do utilitário {@code xsd-oracle}.
 */
public final class XsdOracleMain {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long MAX_REGISTRY_FILE_BYTES = 1024L * 1024L;

    private XsdOracleMain() {
    }

    public static void main(String[] args) throws UnsupportedEncodingException {
        PrintStream utf8Out = new PrintStream(System.out, true, "UTF-8");
        PrintStream utf8Err = new PrintStream(System.err, true, "UTF-8");
        int code = execute(args, utf8Out, utf8Err);
        System.exit(code);
    }

    public static int execute(String[] args, PrintStream out, PrintStream err) {
        if (args == null || args.length == 0) {
            err.println("Uso: xsd-oracle <extract-xsd|extract-java-ast|validate-xml> [opções]");
            return 2;
        }
        String command = args[0];
        try {
            Map<String, String> flags = parseFlags(args, 1);
            switch (command) {
                case "extract-xsd":
                    return handleExtractXsd(flags, out);
                case "validate-xml":
                    return handleValidateXml(flags, out);
                case "extract-java-ast":
                    return handleExtractJavaAst(flags, out);
                default:
                    throw new OracleCliException(2, "Subcomando desconhecido: " + command);
            }
        } catch (OracleCliException e) {
            err.println(e.getMessage());
            return e.getExitCode();
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            err.println("Erro inesperado: " + msg);
            return 2;
        }
    }

    private static int handleExtractXsd(Map<String, String> flags, PrintStream out) throws IOException {
        Path xsdDir = requirePathFlag(flags, "--xsd-dir");
        ExtractXsdResult result = new XsdSchemaExtractor().extract(xsdDir);
        out.println(JSON.writeValueAsString(result));
        return 0;
    }

    private static int handleValidateXml(Map<String, String> flags, PrintStream out) throws IOException {
        Path xsdDir = requirePathFlag(flags, "--xsd-dir");
        Path xmlFile = requirePathFlag(flags, "--xml");
        ValidateXmlResult result = new XsdXmlValidator().validate(xsdDir, xmlFile);
        out.println(JSON.writeValueAsString(result));
        return result.isValid() ? 0 : 1;
    }

    private static int handleExtractJavaAst(Map<String, String> flags, PrintStream out) throws IOException {
        Path repoDir = requirePathFlag(flags, "--repo-dir");
        String regArg = requireStringFlag(flags, "--registry-entry");
        RegistryEntry entry = parseRegistryEntry(regArg);
        ExtractJavaAstResult result = new JavaAstExtractor().extract(repoDir, entry);
        out.println(JSON.writeValueAsString(result));
        return 0;
    }

    private static Map<String, String> parseFlags(String[] args, int startIdx) {
        Map<String, String> flags = new LinkedHashMap<>();
        for (int i = startIdx; i < args.length; i++) {
            String token = args[i];
            if (!token.startsWith("--") || i + 1 >= args.length) {
                throw new OracleCliException(2, "Argumento inválido ou valor ausente: " + token);
            }
            if (flags.containsKey(token)) {
                throw new OracleCliException(2, "Parâmetro duplicado: " + token);
            }
            flags.put(token, args[++i]);
        }
        return flags;
    }

    private static Path requirePathFlag(Map<String, String> flags, String key) {
        return Paths.get(requireStringFlag(flags, key));
    }

    private static String requireStringFlag(Map<String, String> flags, String key) {
        String value = flags.get(key);
        if (value == null || value.trim().isEmpty()) {
            throw new OracleCliException(2, "Parâmetro obrigatório ausente: " + key);
        }
        return value.trim();
    }

    private static RegistryEntry parseRegistryEntry(String raw) {
        try {
            String json = raw;
            if (!raw.startsWith("{")) {
                Path file = Paths.get(raw.startsWith("@") ? raw.substring(1) : raw);
                if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
                    throw new OracleCliException(2, "Arquivo de registro não encontrado: " + file);
                }
                if (Files.size(file) > MAX_REGISTRY_FILE_BYTES) {
                    throw new OracleCliException(2, "Arquivo de registro excede limite de 1MB: " + file);
                }
                json = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            }
            return JSON.readValue(json, RegistryEntry.class);
        } catch (OracleCliException e) {
            throw e;
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            throw new OracleCliException(2, "JSON inválido em --registry-entry: " + msg, e);
        }
    }
}
