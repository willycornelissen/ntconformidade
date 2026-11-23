package br.gov.mg.fazenda.ntc;

import br.gov.mg.fazenda.ntc.ast.JavaAstExtractor;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ExtractJavaAstResult;
import br.gov.mg.fazenda.ntc.model.OracleDtos.RegistryEntry;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class NfeParserAstIntegrationTest {

    @Test
    void ast10ExtractsRealNfeParserCodebaseReadOnly() {
        Path nfeParserDir = resolveNfeParserDir();
        Assumptions.assumeTrue(
                nfeParserDir != null && Files.isDirectory(nfeParserDir),
                "Diretório de referência nfe-parser não encontrado");

        RegistryEntry entry = new RegistryEntry();
        entry.setDfe("NFe");
        entry.setBasePackage("br.gov.mg.fazenda.nfeparser");
        entry.setDomainPackage("br.gov.mg.fazenda.nfeparser.nfe");
        entry.setMapperPackage("br.gov.mg.fazenda.nfeparser.mapper");
        entry.setTablePackage("br.gov.mg.fazenda.nfeparser.table");
        entry.setParserPackage("br.gov.mg.fazenda.nfeparser.parser");
        entry.setUtilPackage("br.gov.mg.fazenda.nfeparser.util");
        entry.setTagPrefix("NFEPROC");

        ExtractJavaAstResult result = new JavaAstExtractor().extract(nfeParserDir, entry);

        assertTrue(result.getSetterKeys().stream().anyMatch(s ->
                s.getFullTagPath().equals("NFEPROC.NFE.INFNFE.IDE.CUF")
                        && s.getMapperClass().equals("NfeMapper")));
        assertTrue(result.getSetterKeys().stream().anyMatch(s ->
                s.getMapperClass().equals("PisMapper")
                        && s.getFullTagPath().contains("NFEPROC.NFE.INFNFE.DET.IMPOSTO.PIS")));
        assertTrue(result.getSetterKeys().stream().anyMatch(s ->
                s.getMapperClass().equals("IcmsMapper")
                        && s.getLeafTag().equals("CST")));
        assertTrue(result.getSetterKeys().stream().anyMatch(s ->
                s.getMapperClass().equals("NveMapper")
                        && s.getLeafTag().equals("NVE")));

        assertTrue(result.getJsonProperties().stream().anyMatch(j ->
                j.getClassName().equals("IbsCbs")
                        && j.getFieldName().equals("gMonoDif_pDifIBS")
                        && j.getJsonName().equals("gMonoDifo_pDifIBS")));
        assertFalse(result.getJsonProperties().stream().anyMatch(j ->
                j.getJsonName().equals("gIBSCredPres_cCredPres")));

        assertTrue(result.getTableFields().stream().anyMatch(t -> t.getTableClass().equals("NfeTable")));
        assertFalse(result.getTableFields().stream().anyMatch(t ->
                t.getFieldName().equals("idCarga")
                        || t.getFieldName().equals("endIpTransmissor")
                        || t.getFieldName().equals("nrPortaOrigem")
                        || t.getFieldName().equals("keyObjectStorage")));
    }

    private static Path resolveNfeParserDir() {
        Path direct = Paths.get("..", "..", "nfe-parser").toAbsolutePath().normalize();
        if (Files.isDirectory(direct)) {
            return direct;
        }
        Path cwdChild = Paths.get("nfe-parser").toAbsolutePath().normalize();
        return Files.isDirectory(cwdChild) ? cwdChild : null;
    }
}
