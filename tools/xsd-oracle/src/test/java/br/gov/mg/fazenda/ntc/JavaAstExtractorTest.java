package br.gov.mg.fazenda.ntc;

import br.gov.mg.fazenda.ntc.ast.JavaAstExtractor;
import br.gov.mg.fazenda.ntc.model.OracleCliException;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ExtractJavaAstResult;
import br.gov.mg.fazenda.ntc.model.OracleDtos.JsonPropertyEntry;
import br.gov.mg.fazenda.ntc.model.OracleDtos.RegistryEntry;
import br.gov.mg.fazenda.ntc.model.OracleDtos.SetterKeyEntry;
import br.gov.mg.fazenda.ntc.model.OracleDtos.TableFieldEntry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class JavaAstExtractorTest {

    private final JavaAstExtractor extractor = new JavaAstExtractor();

    @Test
    void ast01And02ExtractsFullTagPathLambdasMethodRefsAndExactLombokCase(@TempDir Path repo) throws IOException {
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.nfe", "Nfe.java", ""
                + "package br.gov.mg.fazenda.nfeparser.nfe;\n"
                + "public class Nfe {\n"
                + "  private String versao;\n"
                + "  private String chaveAcesso;\n"
                + "  private Integer cuf;\n"
                + "  private java.time.LocalDateTime dtEmissao;\n"
                + "  private java.math.BigDecimal vBC;\n"
                + "  private Integer cMunFGIBS;\n"
                + "  private java.math.BigDecimal vNFTo;\n"
                + "}\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.nfe", "Item.java", ""
                + "package br.gov.mg.fazenda.nfeparser.nfe;\n"
                + "public class Item {\n"
                + "  private String indEscala;\n"
                + "}\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.mapper", "NfeMapper.java", ""
                + "package br.gov.mg.fazenda.nfeparser.mapper;\n"
                + "import br.gov.mg.fazenda.nfeparser.nfe.*;\n"
                + "import java.util.*; import java.util.function.BiConsumer;\n"
                + "public final class NfeMapper {\n"
                + "  private static final Map<String, BiConsumer<Nfe, String>> NFE_FIELD_SETTERS = new HashMap<>();\n"
                + "  static {\n"
                + "    NFE_FIELD_SETTERS.put(\"NFEPROC.NFE.INFNFE.VERSAO\", (nfe, v) -> nfe.setVersao(v));\n"
                + "    NFE_FIELD_SETTERS.put(\"NFEPROC.NFE.INFNFE.ID\", (nfe, v) -> nfe.setChaveAcesso(v.substring(3)));\n"
                + "    NFE_FIELD_SETTERS.put(\"NFEPROC.NFE.INFNFE.IDE.CUF\", (nfe, v) -> nfe.setCuf(Integer.valueOf(v)));\n"
                + "    NFE_FIELD_SETTERS.put(\"NFEPROC.NFE.INFNFE.IDE.DHEMI\", (nfe, v) -> nfe.setDtEmissao(null));\n"
                + "    NFE_FIELD_SETTERS.put(\"NFEPROC.NFE.INFNFE.IDE.DEMI\", (nfe, v) -> nfe.setDtEmissao(null));\n"
                + "    NFE_FIELD_SETTERS.put(\"NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VBC\", (nfe, v) -> nfe.setVBC(null));\n"
                + "    NFE_FIELD_SETTERS.put(\"NFEPROC.NFE.INFNFE.IDE.CMUNFGIBS\", (nfe, v) -> nfe.setCMunFGIBS(null));\n"
                + "    NFE_FIELD_SETTERS.put(\"NFEPROC.NFE.INFNFE.TOTAL.VNF\", (nfe, v) -> nfe.setVNFTo(null));\n"
                + "  }\n"
                + "}\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.mapper", "ItemMapper.java", ""
                + "package br.gov.mg.fazenda.nfeparser.mapper;\n"
                + "import br.gov.mg.fazenda.nfeparser.nfe.Item;\n"
                + "import java.util.*; import java.util.function.BiConsumer;\n"
                + "public final class ItemMapper {\n"
                + "  private static final Map<String, BiConsumer<Item, String>> ITEM_FIELD_SETTERS = new HashMap<>();\n"
                + "  static {\n"
                + "    ITEM_FIELD_SETTERS.put(\"NFEPROC.NFE.INFNFE.DET.PROD.INDESCALA\", Item::setIndEscala);\n"
                + "  }\n"
                + "}\n");

        ExtractJavaAstResult result = extractor.extract(repo, nfeRegistry());

        assertSetter(result, "NFEPROC.NFE.INFNFE.IDE.CUF", "CUF", "NfeMapper", "cuf");
        assertSetter(result, "NFEPROC.NFE.INFNFE.VERSAO", "VERSAO", "NfeMapper", "versao");
        assertSetter(result, "NFEPROC.NFE.INFNFE.ID", "ID", "NfeMapper", "chaveAcesso");
        assertSetter(result, "NFEPROC.NFE.INFNFE.IDE.DHEMI", "DHEMI", "NfeMapper", "dtEmissao");
        assertSetter(result, "NFEPROC.NFE.INFNFE.IDE.DEMI", "DEMI", "NfeMapper", "dtEmissao");
        assertSetter(result, "NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VBC", "VBC", "NfeMapper", "vBC");
        assertSetter(result, "NFEPROC.NFE.INFNFE.IDE.CMUNFGIBS", "CMUNFGIBS", "NfeMapper", "cMunFGIBS");
        assertSetter(result, "NFEPROC.NFE.INFNFE.TOTAL.VNF", "VNF", "NfeMapper", "vNFTo");
        assertSetter(result, "NFEPROC.NFE.INFNFE.DET.PROD.INDESCALA", "INDESCALA", "ItemMapper", "indEscala");
    }

    @Test
    void ast03And04And05And06ResolvesLeafMapsXmlSearchContainsMultiEntryAndDirectMappers(@TempDir Path repo)
            throws IOException {
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.nfe", "Icms.java",
                "package br.gov.mg.fazenda.nfeparser.nfe;\npublic class Icms { private Integer orig; private Integer cst; }\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.nfe", "Pis.java",
                "package br.gov.mg.fazenda.nfeparser.nfe;\npublic class Pis { private java.math.BigDecimal vpis; }\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.nfe", "Endereco.java",
                "package br.gov.mg.fazenda.nfeparser.nfe;\npublic class Endereco { private String xlgr; }\n");

        writeJava(repo, "br.gov.mg.fazenda.nfeparser.mapper", "IcmsMapper.java", ""
                + "package br.gov.mg.fazenda.nfeparser.mapper;\n"
                + "import br.gov.mg.fazenda.nfeparser.nfe.Icms;\n"
                + "import java.util.*; import java.util.function.BiConsumer;\n"
                + "abstract class IcmsMapper {\n"
                + "  private static final Map<String, BiConsumer<Icms, String>> ICMS_SETTERS;\n"
                + "  static {\n"
                + "    ICMS_SETTERS = new HashMap<>();\n"
                + "    ICMS_SETTERS.put(\"ORIG\", (icms, v) -> icms.setOrig(Integer.valueOf(v)));\n"
                + "    ICMS_SETTERS.put(\"CST\", (icms, v) -> icms.setCst(Integer.valueOf(v)));\n"
                + "  }\n"
                + "  static Optional<Icms> getIcmsFromXmlElement(XmlElement detElement) {\n"
                + "    if (!detElement.getTagPath().equalsIgnoreCase(\"NFEPROC.NFE.INFNFE.DET\")) return Optional.empty();\n"
                + "    Optional<XmlElement> icmsEl = XmlSearch.findFromAncestorByTagName(detElement, \"ICMS\");\n"
                + "    ICMS_SETTERS.get(\"ORIG\");\n"
                + "    return Optional.empty();\n"
                + "  }\n"
                + "}\n");

        writeJava(repo, "br.gov.mg.fazenda.nfeparser.mapper", "PisMapper.java", ""
                + "package br.gov.mg.fazenda.nfeparser.mapper;\n"
                + "import br.gov.mg.fazenda.nfeparser.nfe.Pis;\n"
                + "import java.util.*; import java.util.function.BiConsumer;\n"
                + "public final class PisMapper {\n"
                + "  private static final Map<String, BiConsumer<Pis, String>> PIS_FIELD_SETTERS = new HashMap<>();\n"
                + "  static { PIS_FIELD_SETTERS.put(\"VPIS\", (p, v) -> p.setVpis(null)); }\n"
                + "  public static Optional<Pis> getPisFromXmlElement(XmlElement detElement) {\n"
                + "    if (!detElement.getTagPath().equalsIgnoreCase(\"NFEPROC.NFE.INFNFE.DET\")) return Optional.empty();\n"
                + "    List<XmlElement> elements = XmlSearch.findAllFromAncestorByTagName(detElement, \"PIS\");\n"
                + "    for (XmlElement element : elements) {\n"
                + "      if (element.getTagPath().contains(\"NFEPROC.NFE.INFNFE.DET.IMPOSTO.PIS\")) { PIS_FIELD_SETTERS.get(element.getTagName()); }\n"
                + "    }\n"
                + "    return Optional.empty();\n"
                + "  }\n"
                + "  public static Optional<Pis> getPisStFromXmlElement(XmlElement detElement) {\n"
                + "    if (!detElement.getTagPath().equalsIgnoreCase(\"NFEPROC.NFE.INFNFE.DET\")) return Optional.empty();\n"
                + "    Optional<XmlElement> el = XmlSearch.findFromAncestorByTagName(detElement, \"PISST\");\n"
                + "    PIS_FIELD_SETTERS.get(\"VPIS\");\n"
                + "    return Optional.empty();\n"
                + "  }\n"
                + "}\n");

        writeJava(repo, "br.gov.mg.fazenda.nfeparser.mapper", "EnderecoMapper.java", ""
                + "package br.gov.mg.fazenda.nfeparser.mapper;\n"
                + "import br.gov.mg.fazenda.nfeparser.nfe.Endereco;\n"
                + "import java.util.*; import java.util.function.BiConsumer;\n"
                + "public final class EnderecoMapper {\n"
                + "  private static final Map<String, BiConsumer<Endereco, String>> END_SETTERS = new HashMap<>();\n"
                + "  static { END_SETTERS.put(\"XLGR\", (e, v) -> e.setXlgr(v)); }\n"
                + "  public static Optional<Endereco> getEnderecoFromXmlElement(XmlElement el) {\n"
                + "    if (!el.getTagPath().equalsIgnoreCase(\"NFEPROC.NFE.INFNFE.EMIT\")\n"
                + "        && !el.getTagPath().equalsIgnoreCase(\"NFEPROC.NFE.INFNFE.DEST\")) return Optional.empty();\n"
                + "    XmlSearch.findFromAncestorByTagName(el, \"ENDER\");\n"
                + "    END_SETTERS.get(\"XLGR\");\n"
                + "    return Optional.empty();\n"
                + "  }\n"
                + "}\n");

        writeJava(repo, "br.gov.mg.fazenda.nfeparser.mapper", "ParticipanteMapper.java", ""
                + "package br.gov.mg.fazenda.nfeparser.mapper;\n"
                + "import java.util.*; import java.util.function.BiConsumer;\n"
                + "public final class ParticipanteMapper {\n"
                + "  private static final String CONST = \"X\";\n"
                + "  private static final Map<String, String> NON_BICONSUMER = new HashMap<>();\n"
                + "  private static final Map<String, BiConsumer<UnknownDto, String>> PART_SETTERS = new HashMap<>();\n"
                + "  static { PART_SETTERS.put(\"CNPJ\", (p, v) -> p.setCnpj(v)); }\n"
                + "  public static Optional<UnknownDto> getEmit(XmlElement nfe) {\n"
                + "    if (!nfe.getTagPath().equalsIgnoreCase(\"NFEPROC.NFE.INFNFE\")) return Optional.empty();\n"
                + "    return getPerson(nfe, \"EMIT\");\n"
                + "  }\n"
                + "  private static Optional<UnknownDto> getPerson(XmlElement el, String tag) {\n"
                + "    XmlSearch.findFromAncestorByTagName(el, tag);\n"
                + "    PART_SETTERS.get(\"CNPJ\");\n"
                + "    return Optional.empty();\n"
                + "  }\n"
                + "}\n");

        writeJava(repo, "br.gov.mg.fazenda.nfeparser.mapper", "NveMapper.java", ""
                + "package br.gov.mg.fazenda.nfeparser.mapper;\n"
                + "import java.util.*;\n"
                + "public abstract class NveMapper {\n"
                + "  public static List<String> getNveListFromNfeElement(XmlElement element) {\n"
                + "    if (!element.getTagPath().equalsIgnoreCase(\"NFEPROC.NFE.INFNFE.DET\")) return Collections.emptyList();\n"
                + "    List<XmlElement> elements = XmlSearch.findAllFromAncestorByTagName(element, \"NVE\");\n"
                + "    return Collections.emptyList();\n"
                + "  }\n"
                + "}\n");

        ExtractJavaAstResult result = extractor.extract(repo, nfeRegistry());

        assertTrue(hasSetterWithPrefixAndLeaf(result, "NFEPROC.NFE.INFNFE.DET.ICMS", "ORIG", "IcmsMapper"));
        assertTrue(hasSetterWithPrefixAndLeaf(result, "NFEPROC.NFE.INFNFE.DET.IMPOSTO.PIS", "VPIS", "PisMapper"));
        assertTrue(hasSetterWithPrefixAndLeaf(result, "NFEPROC.NFE.INFNFE.DET.PISST", "VPIS", "PisMapper"));
        assertTrue(hasSetterWithPrefixAndLeaf(result, "NFEPROC.NFE.INFNFE.EMIT", "XLGR", "EnderecoMapper"));
        assertTrue(hasSetterWithPrefixAndLeaf(result, "NFEPROC.NFE.INFNFE.DEST", "XLGR", "EnderecoMapper"));
        assertTrue(hasSetterWithPrefixAndLeaf(result, "NFEPROC.NFE.INFNFE.EMIT", "CNPJ", "ParticipanteMapper"));
        assertTrue(hasSetterWithPrefixAndLeaf(result, "NFEPROC.NFE.INFNFE.DET.NVE", "NVE", "NveMapper"));
    }

    @Test
    void ast07And08ExtractsJsonPropertiesExcludesCommentsAndNonXsdTableFieldsAndDeduplicates(@TempDir Path repo)
            throws IOException {
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.nfe", "IbsCbs.java", ""
                + "package br.gov.mg.fazenda.nfeparser.nfe;\n"
                + "import com.fasterxml.jackson.annotation.JsonProperty;\n"
                + "public class IbsCbs {\n"
                + "  @JsonProperty(value = \"gMonoDifo_pDifIBS\")\n"
                + "  private java.math.BigDecimal gMonoDif_pDifIBS;\n"
                + "  // @JsonProperty(\"gIBSCredPres_cCredPres\")\n"
                + "  // private Integer gIBSCredPres_cCredPres;\n"
                + "}\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.nfe", "Item.java", ""
                + "package br.gov.mg.fazenda.nfeparser.nfe;\n"
                + "import com.fasterxml.jackson.annotation.JsonProperty;\n"
                + "public class Item {\n"
                + "  @JsonProperty(\"cProd\")\n"
                + "  private String cProd;\n"
                + "  private java.util.List<String> nve;\n"
                + "  @JsonProperty(\"idCarga\")\n"
                + "  private String idCarga;\n"
                + "}\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.mapper", "StubMapper.java",
                "package br.gov.mg.fazenda.nfeparser.mapper;\npublic class StubMapper {}\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.table", "ItemTable.java", ""
                + "package br.gov.mg.fazenda.nfeparser.table;\n"
                + "public class ItemTable { private Integer cfop; private java.math.BigDecimal gIBSUF_vDif; "
                + "public static Builder builder() { return new Builder(); } public static class Builder {} }\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.table", "NfeMetadataTable.java", ""
                + "package br.gov.mg.fazenda.nfeparser.table;\n"
                + "public class NfeMetadataTable { public void setQtdItem(int q) {} public void setChaveAcesso(String c) {} }\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.parser", "DefaultNfeTableParser.java", ""
                + "package br.gov.mg.fazenda.nfeparser.parser;\n"
                + "import br.gov.mg.fazenda.nfeparser.table.*;\n"
                + "public class DefaultNfeTableParser {\n"
                + "  public void parseItem() {\n"
                + "    ItemTable t = ItemTable.builder()\n"
                + "      .idCarga(1L)\n"
                + "      .endIpTransmissor(\"1.2.3.4\")\n"
                + "      .nrPortaOrigem(80)\n"
                + "      .keyObjectStorage(\"k\")\n"
                + "      .id_emit_cnpj(\"x\")\n"
                + "      .cfop(5102)\n"
                + "      .cfop(5102)\n"
                + "      .gIBSUF_vDif(null)\n"
                + "      .build();\n"
                + "  }\n"
                + "  public void parseMetadata() {\n"
                + "    NfeMetadataTable meta = new NfeMetadataTable();\n"
                + "    meta.setQtdItem(1);\n"
                + "    meta.setChaveAcesso(\"123\");\n"
                + "  }\n"
                + "}\n");

        ExtractJavaAstResult result = extractor.extract(repo, nfeRegistry());

        assertTrue(result.getJsonProperties().stream().anyMatch(j ->
                j.getClassName().equals("IbsCbs")
                        && j.getFieldName().equals("gMonoDif_pDifIBS")
                        && j.getJsonName().equals("gMonoDifo_pDifIBS")));
        assertTrue(result.getJsonProperties().stream().anyMatch(j ->
                j.getClassName().equals("Item")
                        && j.getFieldName().equals("cProd")
                        && j.getJsonName().equals("cProd")));
        assertFalse(result.getJsonProperties().stream().anyMatch(j ->
                j.getJsonName().equals("gIBSCredPres_cCredPres")
                        || j.getFieldName().equals("nve")
                        || j.getFieldName().equals("idCarga")));

        List<TableFieldEntry> cfops = result.getTableFields().stream()
                .filter(t -> t.getTableClass().equals("ItemTable") && t.getFieldName().equals("cfop"))
                .collect(Collectors.toList());
        assertEquals(1, cfops.size(), "Campos duplicados no builder devem ser deduplicados");
        assertTrue(result.getTableFields().stream().anyMatch(t ->
                t.getTableClass().equals("ItemTable") && t.getFieldName().equals("gIBSUF_vDif")));
        assertTrue(result.getTableFields().stream().anyMatch(t ->
                t.getTableClass().equals("NfeMetadataTable") && t.getFieldName().equals("chaveAcesso")));

        for (TableFieldEntry entry : result.getTableFields()) {
            assertFalse(entry.getFieldName().equals("idCarga"));
            assertFalse(entry.getFieldName().equals("endIpTransmissor"));
            assertFalse(entry.getFieldName().equals("nrPortaOrigem"));
            assertFalse(entry.getFieldName().equals("keyObjectStorage"));
            assertFalse(entry.getFieldName().equals("id_emit_cnpj"));
            assertFalse(entry.getFieldName().equals("qtdItem"));
        }
    }

    @Test
    void ast09SupportsCustomDfePackagesFromRegistryEntry(@TempDir Path repo) throws IOException {
        writeJava(repo, "br.gov.mg.fazenda.bpeparser.bpe", "Bpe.java", ""
                + "package br.gov.mg.fazenda.bpeparser.bpe;\n"
                + "import com.fasterxml.jackson.annotation.JsonProperty;\n"
                + "public class Bpe { @JsonProperty(\"cUF\") private Integer cuf; private String x; }\n");
        writeJava(repo, "br.gov.mg.fazenda.bpeparser.mapper", "BpeMapper.java", ""
                + "package br.gov.mg.fazenda.bpeparser.mapper;\n"
                + "import br.gov.mg.fazenda.bpeparser.bpe.Bpe;\n"
                + "import java.util.*; import java.util.function.BiConsumer;\n"
                + "public class BpeMapper {\n"
                + "  private static final Map<String, BiConsumer<Bpe, String>> BPE_SETTERS = new HashMap<>();\n"
                + "  static {\n"
                + "    BPE_SETTERS.put(\"BPEPROC.BPE.INFBPE.IDE.CUF\", (b, v) -> b.setCuf(null));\n"
                + "    BPE_SETTERS.put(\"BPEPROC.BPE.INFBPE.IDE.Z\", (b, v) -> b.setZ(v));\n"
                + "  }\n"
                + "}\n");
        writeJava(repo, "br.gov.mg.fazenda.bpeparser.parser", "DefaultBpeTableParser.java", ""
                + "package br.gov.mg.fazenda.bpeparser.parser;\n"
                + "public class DefaultBpeTableParser {\n"
                + "  public void parse() { BpeTable t = new BpeTable(); t.setId_cnpj(\"1\"); t.setX(\"a\"); }\n"
                + "}\n");

        RegistryEntry bpe = new RegistryEntry();
        bpe.setDfe("BPe");
        bpe.setDomainPackage("br.gov.mg.fazenda.bpeparser.bpe");
        bpe.setMapperPackage("br.gov.mg.fazenda.bpeparser.mapper");
        bpe.setTablePackage("br.gov.mg.fazenda.bpeparser.table");
        bpe.setParserPackage("br.gov.mg.fazenda.bpeparser.parser");
        bpe.setTagPrefix("BPEPROC");

        ExtractJavaAstResult result = extractor.extract(repo, bpe);
        assertSetter(result, "BPEPROC.BPE.INFBPE.IDE.CUF", "CUF", "BpeMapper", "cuf");
        assertSetter(result, "BPEPROC.BPE.INFBPE.IDE.Z", "Z", "BpeMapper", "z");
        assertTrue(result.getJsonProperties().stream().anyMatch(j -> j.getClassName().equals("Bpe")));
        assertTrue(result.getTableFields().stream().anyMatch(t -> t.getFieldName().equals("x")));
        assertFalse(result.getTableFields().stream().anyMatch(t -> t.getFieldName().equals("id_cnpj")));
    }

    @Test
    void ast12RejectsRepoWithoutSrcMainJavaAndBrokenJavaSyntax(@TempDir Path dir) throws IOException {
        OracleCliException ex = assertThrows(
                OracleCliException.class,
                () -> extractor.extract(dir, nfeRegistry()));
        assertEquals(2, ex.getExitCode());

        writeJava(dir, "br.gov.mg.fazenda.nfeparser.nfe", "Broken.java", "public class {");
        OracleCliException parseErr = assertThrows(
                OracleCliException.class,
                () -> extractor.extract(dir, nfeRegistry()));
        assertEquals(2, parseErr.getExitCode());
    }

    @Test
    void ast11RejectsMissingRepoDirOrInvalidRegistry(@TempDir Path dir) {
        OracleCliException missing = assertThrows(
                OracleCliException.class,
                () -> extractor.extract(dir.resolve("inexistente"), nfeRegistry()));
        assertEquals(2, missing.getExitCode());

        OracleCliException nullReg = assertThrows(
                OracleCliException.class,
                () -> extractor.extract(dir, null));
        assertEquals(2, nullReg.getExitCode());

        RegistryEntry emptyReg = new RegistryEntry();
        assertEquals(2, assertThrows(OracleCliException.class, () -> extractor.extract(dir, emptyReg)).getExitCode());

        RegistryEntry noMapper = new RegistryEntry();
        noMapper.setDomainPackage("br.gov.mg.fazenda.x.nfe");
        assertEquals(2, assertThrows(OracleCliException.class, () -> extractor.extract(dir, noMapper)).getExitCode());

        RegistryEntry noPrefix = new RegistryEntry();
        noPrefix.setDomainPackage("br.gov.mg.fazenda.x.nfe");
        noPrefix.setMapperPackage("br.gov.mg.fazenda.x.mapper");
        assertEquals(2, assertThrows(OracleCliException.class, () -> extractor.extract(dir, noPrefix)).getExitCode());
    }

    @Test
    void ast13HandlesPerMethodVarScopingAndNonChainedBuilder(@TempDir Path repo) throws IOException {
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.nfe", "Nfe.java",
                "package br.gov.mg.fazenda.nfeparser.nfe;\npublic class Nfe { private Integer cuf; }\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.mapper", "NfeMapper.java", ""
                + "package br.gov.mg.fazenda.nfeparser.mapper;\n"
                + "import br.gov.mg.fazenda.nfeparser.nfe.Nfe;\n"
                + "import java.util.*; import java.util.function.BiConsumer;\n"
                + "public class NfeMapper {\n"
                + "  private static final Map<String, BiConsumer<Nfe, String>> M = new HashMap<>();\n"
                + "  static { M.put(\"NFEPROC.NFE.INFNFE.IDE.CUF\", (n, v) -> n.setCuf(null)); }\n"
                + "}\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.table", "AlphaTable.java", ""
                + "package br.gov.mg.fazenda.nfeparser.table;\n"
                + "public class AlphaTable {\n"
                + "  private String idDoc;\n"
                + "  public static Builder builder() { return new Builder(); }\n"
                + "  public static class Builder {\n"
                + "    public void idDoc(String v) {}\n"
                + "    public AlphaTable build() { return new AlphaTable(); }\n"
                + "  }\n"
                + "}\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.table", "BetaTable.java", ""
                + "package br.gov.mg.fazenda.nfeparser.table;\n"
                + "public class BetaTable {\n"
                + "  private String codigo;\n"
                + "  public static Builder builder() { return new Builder(); }\n"
                + "  public static class Builder {\n"
                + "    public void codigo(String v) {}\n"
                + "    public BetaTable build() { return new BetaTable(); }\n"
                + "  }\n"
                + "}\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.parser", "ScopedTableParser.java", ""
                + "package br.gov.mg.fazenda.nfeparser.parser;\n"
                + "import br.gov.mg.fazenda.nfeparser.nfe.Nfe;\n"
                + "import br.gov.mg.fazenda.nfeparser.table.*;\n"
                + "public class ScopedTableParser {\n"
                + "  public AlphaTable buildAlpha(Nfe nfe) {\n"
                + "    var b = AlphaTable.builder();\n"
                + "    b.idDoc(nfe.getCuf() + \"\");\n"
                + "    return b.build();\n"
                + "  }\n"
                + "  public BetaTable buildBeta(Nfe nfe) {\n"
                + "    var b = BetaTable.builder();\n"
                + "    b.codigo(\"01\");\n"
                + "    return b.build();\n"
                + "  }\n"
                + "}\n");

        ExtractJavaAstResult result = extractor.extract(repo, nfeRegistry());
        boolean alphaHasIdDoc = result.getTableFields().stream().anyMatch(f ->
                f.getTableClass().equals("AlphaTable") && f.getFieldName().equals("idDoc"));
        boolean betaHasCodigo = result.getTableFields().stream().anyMatch(f ->
                f.getTableClass().equals("BetaTable") && f.getFieldName().equals("codigo"));
        boolean betaLeakedIdDoc = result.getTableFields().stream().anyMatch(f ->
                f.getTableClass().equals("BetaTable") && f.getFieldName().equals("idDoc"));

        assertTrue(alphaHasIdDoc);
        assertTrue(betaHasCodigo);
        assertFalse(betaLeakedIdDoc);
    }

    @Test
    void ast14ExtractsJavaRecordJsonPropertyAndRejectsTraversalPackages(@TempDir Path repo) throws IOException {
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.nfe", "NfeRecord.java", ""
                + "package br.gov.mg.fazenda.nfeparser.nfe;\n"
                + "import com.fasterxml.jackson.annotation.JsonProperty;\n"
                + "public record NfeRecord(@JsonProperty(\"cUF\") String cUf, @JsonProperty(\"idCarga\") String idCarga) {}\n");
        writeJava(repo, "br.gov.mg.fazenda.nfeparser.mapper", "StubMapper.java",
                "package br.gov.mg.fazenda.nfeparser.mapper;\npublic class StubMapper {}\n");

        ExtractJavaAstResult res = extractor.extract(repo, nfeRegistry());
        assertTrue(res.getJsonProperties().stream().anyMatch(j ->
                j.getClassName().equals("NfeRecord")
                        && j.getFieldName().equals("cUf")
                        && j.getJsonName().equals("cUF")));
        assertFalse(res.getJsonProperties().stream().anyMatch(j -> j.getFieldName().equals("idCarga")));

        RegistryEntry badPkg = nfeRegistry();
        badPkg.setDomainPackage("../escape");
        assertEquals(2, assertThrows(OracleCliException.class, () -> extractor.extract(repo, badPkg)).getExitCode());
    }

    private static RegistryEntry nfeRegistry() {
        RegistryEntry entry = new RegistryEntry();
        entry.setDfe("NFe");
        entry.setBasePackage("br.gov.mg.fazenda.nfeparser");
        entry.setDomainPackage("br.gov.mg.fazenda.nfeparser.nfe");
        entry.setMapperPackage("br.gov.mg.fazenda.nfeparser.mapper");
        entry.setTablePackage("br.gov.mg.fazenda.nfeparser.table");
        entry.setParserPackage("br.gov.mg.fazenda.nfeparser.parser");
        entry.setUtilPackage("br.gov.mg.fazenda.nfeparser.util");
        entry.setTagPrefix("NFEPROC");
        return entry;
    }

    private static void writeJava(Path repo, String pkg, String fileName, String content) throws IOException {
        Path dir = repo.resolve("src/main/java").resolve(pkg.replace('.', '/'));
        Files.createDirectories(dir);
        Files.write(dir.resolve(fileName), content.getBytes(StandardCharsets.UTF_8));
    }

    private static void assertSetter(
            ExtractJavaAstResult result,
            String fullTagPath,
            String leafTag,
            String mapperClass,
            String targetDtoField) {
        boolean found = result.getSetterKeys().stream().anyMatch(s ->
                s.getFullTagPath().equals(fullTagPath)
                        && s.getLeafTag().equals(leafTag)
                        && s.getMapperClass().equals(mapperClass)
                        && s.getTargetDtoField().equals(targetDtoField));
        assertTrue(found, "Esperado setter: " + fullTagPath + " -> " + mapperClass + "." + targetDtoField);
    }

    private static boolean hasSetterWithPrefixAndLeaf(
            ExtractJavaAstResult result,
            String expectedPrefix,
            String leafTag,
            String mapperClass) {
        return result.getSetterKeys().stream().anyMatch(s ->
                s.getFullTagPath().startsWith(expectedPrefix)
                        && s.getLeafTag().equals(leafTag)
                        && s.getMapperClass().equals(mapperClass));
    }
}
