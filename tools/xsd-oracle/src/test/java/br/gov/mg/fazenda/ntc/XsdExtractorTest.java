package br.gov.mg.fazenda.ntc;

import br.gov.mg.fazenda.ntc.model.OracleCliException;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ExtractXsdResult;
import br.gov.mg.fazenda.ntc.model.OracleDtos.XsdNode;
import br.gov.mg.fazenda.ntc.xsd.XsdSchemaExtractor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class XsdExtractorTest {

    private static final Path SAMPLE_DIR = Paths.get("src", "test", "resources", "xsd-sample");
    private final XsdSchemaExtractor extractor = new XsdSchemaExtractor();

    @Test
    void xsd01And02And04ExtractHierarchyAttributesAndCardinalities() {
        ExtractXsdResult result = extractor.extract(SAMPLE_DIR);

        assertTrue(result.getRootElements().contains("NFEPROC"));
        assertFalse(result.getRootElements().isEmpty());

        XsdNode cuf = findNode(result, "NFEPROC.NFE.INFNFE.IDE.CUF");
        assertFalse(cuf.isAttribute());
        assertEquals(1, cuf.getMinOccurs());
        assertEquals(1, cuf.getMaxOccurs());

        XsdNode versao = findNode(result, "NFEPROC.NFE.INFNFE.VERSAO");
        assertTrue(versao.isAttribute());
        assertEquals(1, versao.getMinOccurs());
        assertEquals(1, versao.getMaxOccurs());

        XsdNode idAttr = findNode(result, "NFEPROC.NFE.INFNFE.ID");
        assertTrue(idAttr.isAttribute());

        XsdNode nItem = findNode(result, "NFEPROC.NFE.INFNFE.DET.NITEM");
        assertTrue(nItem.isAttribute());

        XsdNode det = findNode(result, "NFEPROC.NFE.INFNFE.DET");
        assertEquals(1, det.getMinOccurs());
        assertEquals(990, det.getMaxOccurs());

        XsdNode nve = findNode(result, "NFEPROC.NFE.INFNFE.DET.PROD.NVE");
        assertEquals(0, nve.getMinOccurs());
        assertEquals(8, nve.getMaxOccurs());

        // Elemento sob xs:choice herda minOccurs=0
        XsdNode cnpj = findNode(result, "NFEPROC.NFE.INFNFE.EMIT.CNPJ");
        assertEquals(0, cnpj.getMinOccurs());
    }

    @Test
    void xsd02To05OptionalProhibitedAttributesSimpleContentChoiceSequenceAndUnbounded(@TempDir Path dir)
            throws IOException {
        String xsd = ""
                + "<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                + "  <xs:element name='root'>\n"
                + "    <xs:complexType>\n"
                + "      <xs:sequence>\n"
                + "        <xs:element name='obsCont' minOccurs='0' maxOccurs='unbounded'>\n"
                + "          <xs:complexType>\n"
                + "            <xs:simpleContent>\n"
                + "              <xs:extension base='xs:string'>\n"
                + "                <xs:attribute name='xCampo' type='xs:string' use='required'/>\n"
                + "                <xs:attribute name='optAttr' type='xs:string'/>\n"
                + "                <xs:attribute name='deadAttr' type='xs:string' use='prohibited'/>\n"
                + "              </xs:extension>\n"
                + "            </xs:simpleContent>\n"
                + "          </xs:complexType>\n"
                + "        </xs:element>\n"
                + "        <xs:sequence minOccurs='0' maxOccurs='unbounded'>\n"
                + "          <xs:element name='obs' type='xs:string'/>\n"
                + "        </xs:sequence>\n"
                + "      </xs:sequence>\n"
                + "    </xs:complexType>\n"
                + "  </xs:element>\n"
                + "</xs:schema>\n";
        Files.write(dir.resolve("root.xsd"), xsd.getBytes(StandardCharsets.UTF_8));

        ExtractXsdResult result = extractor.extract(dir);

        XsdNode obsCont = findNode(result, "ROOT.OBSCONT");
        assertEquals(0, obsCont.getMinOccurs());
        assertEquals("unbounded", obsCont.getMaxOccurs());

        XsdNode xCampo = findNode(result, "ROOT.OBSCONT.XCAMPO");
        assertTrue(xCampo.isAttribute());
        assertEquals(1, xCampo.getMinOccurs());

        XsdNode optAttr = findNode(result, "ROOT.OBSCONT.OPTATTR");
        assertTrue(optAttr.isAttribute());
        assertEquals(0, optAttr.getMinOccurs());

        assertFalse(hasNode(result, "ROOT.OBSCONT.DEADATTR"));

        XsdNode obs = findNode(result, "ROOT.OBS");
        assertEquals(0, obs.getMinOccurs());
        assertEquals("unbounded", obs.getMaxOccurs());
    }

    @Test
    void xsd06ResolvesLocalSubfolderIncludes(@TempDir Path dir) throws IOException {
        Path sub = dir.resolve("sub");
        Files.createDirectories(sub);
        Files.write(
                sub.resolve("complemento.xsd"),
                ("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                        + "  <xs:simpleType name='TComp'><xs:restriction base='xs:string'/></xs:simpleType>\n"
                        + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));
        Files.write(
                dir.resolve("main.xsd"),
                ("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                        + "  <xs:include schemaLocation='sub/complemento.xsd'/>\n"
                        + "  <xs:element name='doc'>\n"
                        + "    <xs:complexType><xs:sequence><xs:element name='campo' type='TComp'/></xs:sequence></xs:complexType>\n"
                        + "  </xs:element>\n"
                        + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));

        ExtractXsdResult result = extractor.extract(dir);
        XsdNode campo = findNode(result, "DOC.CAMPO");
        assertNotNull(campo.getXsdType());
        assertEquals(1, result.getRootElements().size());
    }

    @Test
    void xsd07BlocksPathTraversalInInclude(@TempDir Path dir) throws IOException {
        Path xsdDir = dir.resolve("xsd");
        Files.createDirectories(xsdDir);
        Files.write(
                dir.resolve("fora.xsd"),
                "<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'/>".getBytes(StandardCharsets.UTF_8));
        Files.write(
                xsdDir.resolve("main.xsd"),
                ("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                        + "  <xs:include schemaLocation='../fora.xsd'/>\n"
                        + "  <xs:element name='doc' type='xs:string'/>\n"
                        + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));

        OracleCliException ex = assertThrows(OracleCliException.class, () -> extractor.extract(xsdDir));
        assertEquals(2, ex.getExitCode());
    }

    @Test
    void xsd08BlocksDtdAndXxe(@TempDir Path dir) throws IOException {
        Files.write(
                dir.resolve("xxe.xsd"),
                ("<!DOCTYPE xs:schema [ <!ENTITY xxe SYSTEM 'file:///etc/passwd'> ]>\n"
                        + "<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                        + "  <xs:element name='doc' type='xs:string'/>\n"
                        + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));

        OracleCliException ex = assertThrows(OracleCliException.class, () -> extractor.extract(dir));
        assertEquals(2, ex.getExitCode());
    }

    @Test
    void xsd09BlocksRemoteIncludeSsrf(@TempDir Path dir) throws IOException, InterruptedException {
        AtomicBoolean connected = new AtomicBoolean(false);
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            Thread listener = new Thread(() -> {
                try {
                    server.accept().close();
                    connected.set(true);
                } catch (IOException ignored) {
                }
            });
            listener.setDaemon(true);
            listener.start();

            Files.write(
                    dir.resolve("ssrf.xsd"),
                    ("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                            + "  <xs:include schemaLocation='http://127.0.0.1:" + port + "/evil.xsd'/>\n"
                            + "  <xs:element name='doc' type='xs:string'/>\n"
                            + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));

            OracleCliException ex = assertThrows(OracleCliException.class, () -> extractor.extract(dir));
            assertEquals(2, ex.getExitCode());
            listener.interrupt();
            listener.join(500);
            assertFalse(connected.get(), "Não deve abrir conexão HTTP externa");
        }
    }

    @Test
    void xsd10CapsRecursiveComplexTypesSafely(@TempDir Path dir) throws IOException {
        Files.write(
                dir.resolve("rec.xsd"),
                ("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                        + "  <xs:element name='root' type='TNode'/>\n"
                        + "  <xs:complexType name='TNode'>\n"
                        + "    <xs:sequence>\n"
                        + "      <xs:element name='child' type='TNode' minOccurs='0'/>\n"
                        + "    </xs:sequence>\n"
                        + "  </xs:complexType>\n"
                        + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));

        ExtractXsdResult result = extractor.extract(dir);
        assertTrue(hasNode(result, "ROOT"));
        assertTrue(hasNode(result, "ROOT.CHILD"));
        for (XsdNode node : result.getNodes()) {
            int depth = node.getTagPath().split("\\.").length;
            assertTrue(depth <= 64, "Profundidade excedeu 64: " + depth);
        }
    }

    @Test
    void xsd11RejectsMissingOrEmptyOrFileDirectory(@TempDir Path dir) throws IOException {
        OracleCliException missing = assertThrows(
                OracleCliException.class,
                () -> extractor.extract(dir.resolve("nao-existe")));
        assertEquals(2, missing.getExitCode());

        OracleCliException empty = assertThrows(OracleCliException.class, () -> extractor.extract(dir));
        assertEquals(2, empty.getExitCode());

        Path regularFile = dir.resolve("nota.txt");
        Files.write(regularFile, "abc".getBytes(StandardCharsets.UTF_8));
        OracleCliException notDir = assertThrows(OracleCliException.class, () -> extractor.extract(regularFile));
        assertEquals(2, notDir.getExitCode());
    }

    @Test
    void xsd12MergesDuplicateBranchCardinalitiesAndHandlesCyclicIncludes(@TempDir Path dir) throws IOException {
        Files.write(
                dir.resolve("a.xsd"),
                ("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                        + "  <xs:include schemaLocation='b.xsd'/>\n"
                        + "  <xs:element name='root'>\n"
                        + "    <xs:complexType>\n"
                        + "      <xs:sequence>\n"
                        + "        <xs:element name='item' type='xs:string' minOccurs='1' maxOccurs='1'/>\n"
                        + "        <xs:element name='item' type='xs:string' minOccurs='0' maxOccurs='unbounded'/>\n"
                        + "        <xs:element name='flex' type='xs:string' minOccurs='0' maxOccurs='unbounded'/>\n"
                        + "        <xs:element name='flex' type='xs:string' minOccurs='1' maxOccurs='1'/>\n"
                        + "        <xs:element name='anyVal'/>\n"
                        + "      </xs:sequence>\n"
                        + "    </xs:complexType>\n"
                        + "  </xs:element>\n"
                        + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));
        Files.write(
                dir.resolve("b.xsd"),
                ("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                        + "  <xs:include schemaLocation='a.xsd'/>\n"
                        + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));

        ExtractXsdResult result = extractor.extract(dir);
        XsdNode item = findNode(result, "ROOT.ITEM");
        assertEquals(0, item.getMinOccurs());
        assertEquals("unbounded", item.getMaxOccurs());

        XsdNode flex = findNode(result, "ROOT.FLEX");
        assertEquals(0, flex.getMinOccurs());
        assertEquals("unbounded", flex.getMaxOccurs());

        XsdNode anyVal = findNode(result, "ROOT.ANYVAL");
        assertEquals("xs:anyType", anyVal.getXsdType());
    }

    @Test
    void xsd14BlocksDoctypeInNonXsdIncludeAndComputesExactOccurrences(@TempDir Path dir) throws IOException {
        Path nonXsd = dir.resolve("nonxsd");
        Files.createDirectories(nonXsd);
        Files.write(
                nonXsd.resolve("defs.inc"),
                "<!DOCTYPE xs:schema [ <!ENTITY xxe SYSTEM 'file:///etc/passwd'> ]><xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'/>"
                        .getBytes(StandardCharsets.UTF_8));
        Files.write(
                nonXsd.resolve("main.xsd"),
                ("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                        + "  <xs:include schemaLocation='defs.inc'/>\n"
                        + "  <xs:element name='doc' type='xs:string'/>\n"
                        + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));
        assertEquals(2, assertThrows(OracleCliException.class, () -> extractor.extract(nonXsd)).getExitCode());

        Path occ = dir.resolve("occ");
        Files.createDirectories(occ);
        Files.write(
                occ.resolve("occ.xsd"),
                ("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                        + "  <xs:element name='doc'>\n"
                        + "    <xs:complexType>\n"
                        + "      <xs:sequence minOccurs='2' maxOccurs='3'>\n"
                        + "        <xs:element name='rep' type='xs:string' minOccurs='3' maxOccurs='4'/>\n"
                        + "        <xs:element name='prohib' type='xs:string' minOccurs='0' maxOccurs='0'/>\n"
                        + "      </xs:sequence>\n"
                        + "    </xs:complexType>\n"
                        + "  </xs:element>\n"
                        + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));
        ExtractXsdResult occRes = extractor.extract(occ);
        XsdNode rep = findNode(occRes, "DOC.REP");
        assertEquals(6, rep.getMinOccurs());
        assertEquals(12, rep.getMaxOccurs());
        assertFalse(hasNode(occRes, "DOC.PROHIB"));
    }

    @Test
    void xsd13RejectsMalformedXsdAndExternalFileUri(@TempDir Path dir) throws IOException {
        Path broken = dir.resolve("broken");
        Files.createDirectories(broken);
        Files.write(broken.resolve("bad.xsd"), "<xs:schema".getBytes(StandardCharsets.UTF_8));
        OracleCliException bad = assertThrows(OracleCliException.class, () -> extractor.extract(broken));
        assertEquals(2, bad.getExitCode());

        Path extFile = dir.resolve("ext");
        Files.createDirectories(extFile);
        Files.write(
                extFile.resolve("main.xsd"),
                ("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                        + "  <xs:include schemaLocation='file:///etc/passwd'/>\n"
                        + "  <xs:element name='doc' type='xs:string'/>\n"
                        + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));
        OracleCliException blocked = assertThrows(OracleCliException.class, () -> extractor.extract(extFile));
        assertEquals(2, blocked.getExitCode());
    }

    @Test
    void xsd15RejectsFileUriWithHostUncAndGroupDiamondDos(@TempDir Path dir) throws IOException {
        Path hostDir = dir.resolve("hosturi");
        Files.createDirectories(hostDir);
        Files.write(
                hostDir.resolve("main.xsd"),
                ("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                        + "  <xs:include schemaLocation='file://evil.example/etc/passwd'/>\n"
                        + "  <xs:element name='doc' type='xs:string'/>\n"
                        + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));
        assertEquals(2, assertThrows(OracleCliException.class, () -> extractor.extract(hostDir)).getExitCode());

        Path uncDir = dir.resolve("uncuri");
        Files.createDirectories(uncDir);
        Files.write(
                uncDir.resolve("main.xsd"),
                ("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n"
                        + "  <xs:include schemaLocation='//127.0.0.1/share/a.xsd'/>\n"
                        + "  <xs:element name='doc' type='xs:string'/>\n"
                        + "</xs:schema>\n").getBytes(StandardCharsets.UTF_8));
        assertEquals(2, assertThrows(OracleCliException.class, () -> extractor.extract(uncDir)).getExitCode());

        // Explosão exponencial via grupos em diamante (2^17 = 131072 > MAX_PARTICLE_VISITS)
        StringBuilder sb = new StringBuilder();
        sb.append("<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'>\n");
        sb.append("  <xs:element name='root'><xs:complexType><xs:sequence>");
        sb.append("<xs:group ref='g0'/>");
        sb.append("</xs:sequence></xs:complexType></xs:element>\n");
        for (int i = 0; i < 17; i++) {
            sb.append("  <xs:group name='g").append(i).append("'><xs:sequence>");
            sb.append("<xs:group ref='g").append(i + 1).append("'/>");
            sb.append("<xs:group ref='g").append(i + 1).append("'/>");
            sb.append("</xs:sequence></xs:group>\n");
        }
        sb.append("  <xs:group name='g17'><xs:sequence><xs:element name='leaf' type='xs:string'/></xs:sequence></xs:group>\n");
        sb.append("</xs:schema>\n");
        Path dosDir = dir.resolve("diamond");
        Files.createDirectories(dosDir);
        Files.write(dosDir.resolve("dos.xsd"), sb.toString().getBytes(StandardCharsets.UTF_8));
        assertEquals(2, assertThrows(OracleCliException.class, () -> extractor.extract(dosDir)).getExitCode());
    }

    @Test
    void xsd16RejectsSymlinkInsideXsdDirectory(@TempDir Path dir) throws IOException {
        Path outside = Files.createTempFile("outside-schema", ".xsd");
        Files.write(
                outside,
                "<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'><xs:element name='x' type='xs:string'/></xs:schema>"
                        .getBytes(StandardCharsets.UTF_8));
        try {
            Path link = dir.resolve("linked.xsd");
            Files.createSymbolicLink(link, outside);
            assertEquals(2, assertThrows(OracleCliException.class, () -> extractor.extract(dir)).getExitCode());
        } finally {
            Files.deleteIfExists(outside);
        }
    }

    private static XsdNode findNode(ExtractXsdResult result, String tagPath) {
        Optional<XsdNode> found = result.getNodes().stream()
                .filter(n -> n.getTagPath().equals(tagPath))
                .findFirst();
        assertTrue(found.isPresent(), "Nó XSD esperado ausente: " + tagPath);
        return found.get();
    }

    private static boolean hasNode(ExtractXsdResult result, String tagPath) {
        return result.getNodes().stream().anyMatch(n -> n.getTagPath().equals(tagPath));
    }
}
