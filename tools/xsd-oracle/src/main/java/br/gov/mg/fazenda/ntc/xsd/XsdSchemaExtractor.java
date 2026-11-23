package br.gov.mg.fazenda.ntc.xsd;

import br.gov.mg.fazenda.ntc.model.OracleCliException;
import br.gov.mg.fazenda.ntc.model.OracleDtos.ExtractXsdResult;
import br.gov.mg.fazenda.ntc.model.OracleDtos.XsdNode;
import org.apache.xerces.dom.DOMXSImplementationSourceImpl;
import org.apache.xerces.impl.xs.util.StringListImpl;
import org.apache.xerces.util.SecurityManager;
import org.apache.xerces.xs.XSAttributeUse;
import org.apache.xerces.xs.XSComplexTypeDefinition;
import org.apache.xerces.xs.XSConstants;
import org.apache.xerces.xs.XSElementDeclaration;
import org.apache.xerces.xs.XSImplementation;
import org.apache.xerces.xs.XSLoader;
import org.apache.xerces.xs.XSModel;
import org.apache.xerces.xs.XSModelGroup;
import org.apache.xerces.xs.XSNamedMap;
import org.apache.xerces.xs.XSObjectList;
import org.apache.xerces.xs.XSParticle;
import org.apache.xerces.xs.XSSimpleTypeDefinition;
import org.apache.xerces.xs.XSTerm;
import org.apache.xerces.xs.XSTypeDefinition;
import org.w3c.dom.DOMConfiguration;
import org.w3c.dom.DOMError;
import org.w3c.dom.DOMErrorHandler;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Extrator determinístico de árvore canônica de elementos e atributos XSD via Xerces {@link XSModel}.
 */
public final class XsdSchemaExtractor {

    static final int MAX_DEPTH = 64;
    static final int MAX_PARTICLE_VISITS = 50_000;
    private static final String DISALLOW_DOCTYPE = "http://apache.org/xml/features/disallow-doctype-decl";
    private static final String XERCES_SEC_MGR = "http://apache.org/xml/properties/security-manager";

    public ExtractXsdResult extract(Path xsdDir) {
        List<Path> allXsds = XsdSecurityConfig.listXsdFiles(xsdDir);
        List<Path> rootXsds = XsdSecurityConfig.findRootXsds(allXsds, xsdDir);
        XSModel model = loadXsModel(xsdDir, rootXsds);

        Set<String> rootElements = new LinkedHashSet<>();
        Map<String, XsdNode> nodesByKey = new LinkedHashMap<>();
        int[] visitBudget = new int[] { 0 };
        Set<XSModelGroup> activeGroups = Collections.newSetFromMap(new IdentityHashMap<XSModelGroup, Boolean>());
        XSNamedMap globalElements = model.getComponents(XSConstants.ELEMENT_DECLARATION);

        for (int i = 0; i < globalElements.getLength(); i++) {
            XSElementDeclaration el = (XSElementDeclaration) globalElements.item(i);
            String rootName = el.getName().toUpperCase(Locale.ROOT);
            rootElements.add(rootName);
            traverseElement(
                    el, rootName, 1, 1, false, 1,
                    new HashSet<>(), activeGroups, visitBudget, nodesByKey);
        }

        return new ExtractXsdResult(
                new ArrayList<>(rootElements),
                new ArrayList<>(nodesByKey.values()));
    }

    private XSModel loadXsModel(Path xsdDir, List<Path> rootXsds) {
        DOMXSImplementationSourceImpl source = new DOMXSImplementationSourceImpl();
        XSImplementation impl = (XSImplementation) source.getDOMImplementation("XS-Loader");
        XSLoader loader = impl.createXSLoader(null);
        configureLoader(loader.getConfig(), xsdDir);

        String[] uris = new String[rootXsds.size()];
        for (int i = 0; i < rootXsds.size(); i++) {
            uris[i] = rootXsds.get(i).toUri().toString();
        }
        XSModel model = loader.loadURIList(new StringListImpl(uris, uris.length));
        if (model == null) {
            throw new OracleCliException(2, "Falha ao carregar XSModel em: " + xsdDir);
        }
        return model;
    }

    private void configureLoader(DOMConfiguration config, Path xsdDir) {
        config.setParameter("resource-resolver", new LocalXsdResourceResolver(xsdDir));
        config.setParameter("error-handler", (DOMErrorHandler) this::handleDomError);
        // Xerces XSLoader.canSetParameter retorna false mesmo para propriedades aceitas em setParameter
        config.setParameter(DISALLOW_DOCTYPE, Boolean.TRUE);
        config.setParameter(XERCES_SEC_MGR, new SecurityManager());
    }

    private boolean handleDomError(DOMError error) {
        if (error.getSeverity() >= DOMError.SEVERITY_ERROR) {
            throw new OracleCliException(2, "Erro XSD: " + error.getMessage());
        }
        return true;
    }

    private void traverseElement(
            XSElementDeclaration el,
            String tagPath,
            int minOccurs,
            int maxOccurs,
            boolean unbounded,
            int depth,
            Set<String> activeComplexTypes,
            Set<XSModelGroup> activeGroups,
            int[] visitBudget,
            Map<String, XsdNode> nodesByKey) {
        Object maxVal = (!unbounded || maxOccurs == 0) ? Integer.valueOf(maxOccurs) : "unbounded";
        String xsdType = resolveTypeName(el.getTypeDefinition());
        recordNode(nodesByKey, new XsdNode(tagPath, xsdType, minOccurs, maxVal, false));

        if (depth >= MAX_DEPTH || !(el.getTypeDefinition() instanceof XSComplexTypeDefinition)) {
            return;
        }
        XSComplexTypeDefinition complex = (XSComplexTypeDefinition) el.getTypeDefinition();
        String typeKey = complex.getName() != null ? complex.getNamespace() + "#" + complex.getName() : null;
        if (typeKey != null && !activeComplexTypes.add(typeKey)) {
            return;
        }
        try {
            traverseAttributes(complex, tagPath, nodesByKey);
            if (complex.getParticle() != null) {
                traverseParticle(
                        complex.getParticle(), tagPath, 1, 1, false,
                        depth, activeComplexTypes, activeGroups, visitBudget, nodesByKey);
            }
        } finally {
            if (typeKey != null) {
                activeComplexTypes.remove(typeKey);
            }
        }
    }

    private void traverseAttributes(
            XSComplexTypeDefinition complex,
            String parentPath,
            Map<String, XsdNode> nodesByKey) {
        XSObjectList attrs = complex.getAttributeUses();
        for (int i = 0; i < attrs.getLength(); i++) {
            XSAttributeUse use = (XSAttributeUse) attrs.item(i);
            String attrName = use.getAttrDeclaration().getName().toUpperCase(Locale.ROOT);
            String attrPath = parentPath + "." + attrName;
            int min = use.getRequired() ? 1 : 0;
            String typeName = resolveTypeName(use.getAttrDeclaration().getTypeDefinition());
            recordNode(nodesByKey, new XsdNode(attrPath, typeName, min, Integer.valueOf(1), true));
        }
    }

    private void traverseParticle(
            XSParticle particle,
            String parentPath,
            int parentMinFactor,
            int parentMaxFactor,
            boolean parentUnbounded,
            int depth,
            Set<String> activeComplexTypes,
            Set<XSModelGroup> activeGroups,
            int[] visitBudget,
            Map<String, XsdNode> nodesByKey) {
        if (++visitBudget[0] > MAX_PARTICLE_VISITS) {
            throw new OracleCliException(2, "Limite máximo de partículas XSD excedido (" + MAX_PARTICLE_VISITS + ")");
        }
        int effMin = multiplySaturating(parentMinFactor, particle.getMinOccurs());
        boolean isZeroMax = parentMaxFactor == 0 || (!particle.getMaxOccursUnbounded() && particle.getMaxOccurs() == 0);
        boolean effUnbounded = !isZeroMax && (parentUnbounded || particle.getMaxOccursUnbounded());
        int effMax = isZeroMax ? 0 : (effUnbounded ? -1 : multiplySaturating(parentMaxFactor, particle.getMaxOccurs()));

        XSTerm term = particle.getTerm();
        if (term instanceof XSElementDeclaration) {
            XSElementDeclaration child = (XSElementDeclaration) term;
            String childPath = parentPath + "." + child.getName().toUpperCase(Locale.ROOT);
            traverseElement(
                    child, childPath, effMin, effMax, effUnbounded,
                    depth + 1, activeComplexTypes, activeGroups, visitBudget, nodesByKey);
        } else if (term instanceof XSModelGroup) {
            XSModelGroup group = (XSModelGroup) term;
            if (!activeGroups.add(group)) {
                return;
            }
            try {
                int groupMin = group.getCompositor() == XSModelGroup.COMPOSITOR_CHOICE ? 0 : effMin;
                XSObjectList sub = group.getParticles();
                for (int i = 0; i < sub.getLength(); i++) {
                    traverseParticle(
                            (XSParticle) sub.item(i),
                            parentPath,
                            groupMin,
                            effMax,
                            effUnbounded,
                            depth,
                            activeComplexTypes,
                            activeGroups,
                            visitBudget,
                            nodesByKey);
                }
            } finally {
                activeGroups.remove(group);
            }
        }
    }

    private void recordNode(Map<String, XsdNode> nodesByKey, XsdNode candidate) {
        String key = candidate.getTagPath() + "|" + candidate.isAttribute();
        XsdNode existing = nodesByKey.get(key);
        if (existing == null) {
            nodesByKey.put(key, candidate);
            return;
        }
        int mergedMin = Math.min(existing.getMinOccurs(), candidate.getMinOccurs());
        Object mergedMax = mergeMax(existing.getMaxOccurs(), candidate.getMaxOccurs());
        nodesByKey.put(
                key,
                new XsdNode(
                        candidate.getTagPath(),
                        candidate.getXsdType(),
                        mergedMin,
                        mergedMax,
                        candidate.isAttribute()));
    }

    private Object mergeMax(Object a, Object b) {
        if ("unbounded".equals(a) || "unbounded".equals(b)) {
            return "unbounded";
        }
        return Integer.valueOf(Math.max(((Integer) a).intValue(), ((Integer) b).intValue()));
    }

    private int multiplySaturating(int a, int b) {
        long prod = (long) a * (long) b;
        return prod > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) prod;
    }

    private String resolveTypeName(XSTypeDefinition typeDef) {
        if (typeDef == null) {
            return "xs:anyType";
        }
        if (typeDef.getName() != null && !typeDef.getName().isEmpty()) {
            String ns = typeDef.getNamespace();
            return "http://www.w3.org/2001/XMLSchema".equals(ns)
                    ? "xs:" + typeDef.getName()
                    : typeDef.getName();
        }
        if (typeDef instanceof XSSimpleTypeDefinition) {
            return resolveTypeName(((XSSimpleTypeDefinition) typeDef).getBaseType());
        }
        return "complexType";
    }
}
