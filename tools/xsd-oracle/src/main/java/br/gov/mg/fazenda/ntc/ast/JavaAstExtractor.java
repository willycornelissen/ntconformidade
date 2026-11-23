package br.gov.mg.fazenda.ntc.ast;

import br.gov.mg.fazenda.ntc.ast.DtoAndTableAstAnalyzer.DomainCatalog;
import br.gov.mg.fazenda.ntc.model.OracleCliException;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ExtractJavaAstResult;
import br.gov.mg.fazenda.ntc.model.OracleDtos.RegistryEntry;
import br.gov.mg.fazenda.ntc.model.OracleDtos.SetterKeyEntry;
import br.gov.mg.fazenda.ntc.model.OracleDtos.TableFieldEntry;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Orquestrador da extração determinística de AST Java para repositórios DFe.
 */
public final class JavaAstExtractor {

    private final DtoAndTableAstAnalyzer dtoAndTableAnalyzer = new DtoAndTableAstAnalyzer();
    private final MapperAstAnalyzer mapperAnalyzer = new MapperAstAnalyzer(dtoAndTableAnalyzer);

    public ExtractJavaAstResult extract(Path repoDir, RegistryEntry entry) {
        validateInputs(repoDir, entry);
        Path srcMainJava = repoDir.resolve("src").resolve("main").resolve("java");
        if (!Files.isDirectory(srcMainJava)) {
            throw new OracleCliException(2, "Diretório src/main/java não encontrado em: " + repoDir);
        }

        String parserPackage = resolveParserPackage(entry);
        DomainCatalog domainCatalog = dtoAndTableAnalyzer.inspectDomainPackage(srcMainJava, entry.getDomainPackage());
        List<SetterKeyEntry> setters = mapperAnalyzer.inspectMappers(srcMainJava, entry, domainCatalog);
        List<TableFieldEntry> tableFields = dtoAndTableAnalyzer.inspectTables(
                srcMainJava,
                parserPackage,
                entry.getTablePackage());

        return new ExtractJavaAstResult(setters, domainCatalog.getJsonProperties(), tableFields);
    }

    private void validateInputs(Path repoDir, RegistryEntry entry) {
        if (repoDir == null || !Files.isDirectory(repoDir)) {
            throw new OracleCliException(2, "Diretório de repositório inválido: " + repoDir);
        }
        if (entry == null
                || isBlank(entry.getDomainPackage())
                || isBlank(entry.getMapperPackage())
                || isBlank(entry.getTagPrefix())) {
            throw new OracleCliException(2, "RegistryEntry inválido: domainPackage, mapperPackage e tagPrefix são obrigatórios");
        }
    }

    private String resolveParserPackage(RegistryEntry entry) {
        if (!isBlank(entry.getParserPackage())) {
            return entry.getParserPackage();
        }
        if (!isBlank(entry.getBasePackage())) {
            return entry.getBasePackage() + ".parser";
        }
        return "";
    }

    private static boolean isBlank(String s) {
        return s == null || s.trim().isEmpty();
    }
}
