package br.gov.mg.fazenda.ntc.ast;

import br.gov.mg.fazenda.ntc.ast.DtoAndTableAstAnalyzer.DomainCatalog;
import br.gov.mg.fazenda.ntc.model.OracleDtos.RegistryEntry;
import br.gov.mg.fazenda.ntc.model.OracleDtos.SetterKeyEntry;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.MethodReferenceExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.expr.VariableDeclarationExpr;
import com.github.javaparser.ast.stmt.SwitchEntry;
import com.github.javaparser.ast.stmt.SwitchStmt;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.ast.type.Type;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Analisador AST para mappers Java ({@code Map<String, BiConsumer<..., String>>},
 * busca via {@code XmlSearch} e mappers diretos como {@code NveMapper}).
 */
public final class MapperAstAnalyzer {

    private final DtoAndTableAstAnalyzer common;

    public MapperAstAnalyzer(DtoAndTableAstAnalyzer common) {
        this.common = common;
    }

    private static final class MapPutEntry {
        private final String mapName;
        private final String key;
        private final String targetDtoField;

        private MapPutEntry(String mapName, String key, String targetDtoField) {
            this.mapName = mapName;
            this.key = key;
            this.targetDtoField = targetDtoField;
        }
    }

    public List<SetterKeyEntry> inspectMappers(
            Path srcMainJava,
            RegistryEntry entry,
            DomainCatalog domainCatalog) {
        Path mapperDir = common.requireExistingPackageDir(srcMainJava, entry.getMapperPackage(), "mapperPackage");
        String tagPrefix = entry.getTagPrefix().toUpperCase(Locale.ROOT);
        Set<String> dedup = new LinkedHashSet<>();
        List<SetterKeyEntry> results = new ArrayList<>();

        for (Path javaFile : common.listJavaFiles(mapperDir)) {
            CompilationUnit cu = common.parseFile(javaFile);
            for (TypeDeclaration<?> type : cu.getTypes()) {
                analyzeMapperClass(type, tagPrefix, domainCatalog, dedup, results);
            }
        }
        return results;
    }

    private void analyzeMapperClass(
            TypeDeclaration<?> cls,
            String tagPrefix,
            DomainCatalog domainCatalog,
            Set<String> dedup,
            List<SetterKeyEntry> results) {
        String mapperClass = cls.getNameAsString();
        Map<String, String> mapTargetDtos = collectSetterMapTargetDtos(cls);
        List<MapPutEntry> putEntries = collectMapPutEntries(cls, mapTargetDtos, domainCatalog);

        int switchCount = 0;
        if (!putEntries.isEmpty()) {
            Map<String, Set<String>> prefixesByMap = resolvePrefixesPerMap(cls, mapTargetDtos.keySet());
            for (MapPutEntry put : putEntries) {
                String leaf = lastSegment(put.key);
                Set<String> prefixes = prefixesByMap.get(put.mapName);
                if (put.key.startsWith(tagPrefix + ".") || prefixes == null || prefixes.isEmpty()) {
                    addEntry(dedup, results, put.key, leaf, mapperClass, put.targetDtoField);
                } else {
                    for (String prefix : prefixes) {
                        addEntry(dedup, results, prefix + "." + put.key, leaf, mapperClass, put.targetDtoField);
                    }
                }
            }
        } else {
            switchCount = collectSwitchTagPathEntries(cls, mapperClass, tagPrefix, domainCatalog, dedup, results);
        }

        if (putEntries.isEmpty() && switchCount == 0) {
            collectDirectXmlSearchEntries(cls, mapperClass, tagPrefix, dedup, results);
        }
    }

    private Map<String, String> collectSetterMapTargetDtos(TypeDeclaration<?> cls) {
        Map<String, String> mapDtos = new LinkedHashMap<>();
        for (FieldDeclaration fd : cls.getFields()) {
            String dtoType = extractBiConsumerDtoType(fd.getElementType());
            if (dtoType != null) {
                for (VariableDeclarator vd : fd.getVariables()) {
                    mapDtos.put(vd.getNameAsString(), dtoType);
                }
            }
        }
        return mapDtos;
    }

    private String extractBiConsumerDtoType(Type fieldType) {
        if (!(fieldType instanceof ClassOrInterfaceType)) {
            return null;
        }
        ClassOrInterfaceType cit = (ClassOrInterfaceType) fieldType;
        String mapSimple = cit.getNameAsString();
        List<Type> args = cit.getTypeArguments().orElse(null);
        if (!(mapSimple.equals("Map") || mapSimple.equals("HashMap")) || args == null || args.size() != 2) {
            return null;
        }
        if (!(args.get(1) instanceof ClassOrInterfaceType)) {
            return null;
        }
        ClassOrInterfaceType valueType = (ClassOrInterfaceType) args.get(1);
        List<Type> biArgs = valueType.getTypeArguments().orElse(null);
        if (!valueType.getNameAsString().equals("BiConsumer") || biArgs == null || biArgs.isEmpty()) {
            return null;
        }
        return biArgs.get(0).asString();
    }

    private List<MapPutEntry> collectMapPutEntries(
            TypeDeclaration<?> cls,
            Map<String, String> mapTargetDtos,
            DomainCatalog domainCatalog) {
        List<MapPutEntry> entries = new ArrayList<>();
        for (MethodCallExpr call : cls.findAll(MethodCallExpr.class)) {
            String mapName = extractTargetMapName(call);
            String dtoType = mapName != null ? mapTargetDtos.get(mapName) : null;
            if (dtoType == null) {
                continue;
            }
            String key = ((StringLiteralExpr) call.getArgument(0)).asString().toUpperCase(Locale.ROOT);
            String setterSuffix = extractSetterSuffix(call.getArgument(1));
            entries.add(new MapPutEntry(mapName, key, domainCatalog.resolveFieldName(dtoType, setterSuffix)));
        }
        return entries;
    }

    private static String extractTargetMapName(MethodCallExpr call) {
        Expression scope = call.getScope().orElse(null);
        if (call.getNameAsString().equals("put")
                && call.getArguments().size() == 2
                && scope instanceof NameExpr
                && call.getArgument(0) instanceof StringLiteralExpr) {
            return ((NameExpr) scope).getNameAsString();
        }
        return null;
    }

    private String extractSetterSuffix(Expression setterExpr) {
        if (setterExpr instanceof MethodReferenceExpr) {
            return stripSetPrefix(((MethodReferenceExpr) setterExpr).getIdentifier());
        }
        if (setterExpr instanceof LambdaExpr) {
            LambdaExpr lambda = (LambdaExpr) setterExpr;
            String targetParam = lambda.getParameters().isEmpty()
                    ? null
                    : lambda.getParameter(0).getNameAsString();
            for (MethodCallExpr mc : lambda.findAll(MethodCallExpr.class)) {
                if (mc.getNameAsString().startsWith("set")) {
                    Expression scope = mc.getScope().orElse(null);
                    if (targetParam == null || (scope instanceof NameExpr && ((NameExpr) scope).getNameAsString().equals(targetParam))) {
                        return stripSetPrefix(mc.getNameAsString());
                    }
                }
            }
        }
        return "";
    }

    private Map<String, Set<String>> resolvePrefixesPerMap(
            TypeDeclaration<?> cls,
            Set<String> mapNames) {
        Map<String, Set<String>> byMap = new LinkedHashMap<>();
        Map<String, List<MethodDeclaration>> methodsByName = indexMethodsByName(cls);

        for (MethodDeclaration md : cls.getMethods()) {
            Set<String> usedMaps = findReferencedMapsIncludingHelpers(md, mapNames, methodsByName);
            if (usedMaps.isEmpty()) {
                continue;
            }
            Set<String> methodPrefixes = resolveMethodPrefixes(md, methodsByName);
            for (String mapName : usedMaps) {
                byMap.computeIfAbsent(mapName, k -> new LinkedHashSet<>()).addAll(methodPrefixes);
            }
        }
        return byMap;
    }

    private Set<String> findReferencedMapsIncludingHelpers(
            MethodDeclaration md,
            Set<String> mapNames,
            Map<String, List<MethodDeclaration>> methodsByName) {
        Set<String> found = findReferencedMaps(md, mapNames);
        for (MethodCallExpr call : md.findAll(MethodCallExpr.class)) {
            List<MethodDeclaration> helpers = methodsByName.get(call.getNameAsString());
            if (helpers != null) {
                for (MethodDeclaration helper : helpers) {
                    if (helper.getParameters().size() == call.getArguments().size()) {
                        found.addAll(findReferencedMaps(helper, mapNames));
                    }
                }
            }
        }
        return found;
    }

    private Set<String> resolveMethodPrefixes(
            MethodDeclaration md,
            Map<String, List<MethodDeclaration>> methodsByName) {
        Set<String> prefixes = new LinkedHashSet<>();
        for (MethodCallExpr call : md.findAll(MethodCallExpr.class)) {
            String lit = extractTagPathGuardLiteral(call, "contains");
            if (lit != null) {
                prefixes.add(lit);
            }
        }
        if (!prefixes.isEmpty()) {
            return prefixes;
        }

        List<String> basePaths = extractEqualsIgnoreCasePaths(md);
        List<String> searchTags = extractXmlSearchTags(md, methodsByName);
        for (String base : basePaths) {
            if (searchTags.isEmpty()) {
                prefixes.add(base);
                continue;
            }
            for (String tag : searchTags) {
                prefixes.add(base.endsWith("." + tag) ? base : base + "." + tag);
            }
        }
        return prefixes;
    }

    private List<String> extractEqualsIgnoreCasePaths(MethodDeclaration md) {
        List<String> paths = new ArrayList<>();
        for (MethodCallExpr call : md.findAll(MethodCallExpr.class)) {
            String lit = extractTagPathGuardLiteral(call, "equalsIgnoreCase");
            if (lit != null) {
                paths.add(lit);
            }
        }
        return paths;
    }

    private static String extractTagPathGuardLiteral(MethodCallExpr call, String methodName) {
        Expression scope = call.getScope().orElse(null);
        if (call.getNameAsString().equals(methodName)
                && scope != null
                && scope.toString().contains("getTagPath")
                && call.getArguments().size() == 1
                && call.getArgument(0) instanceof StringLiteralExpr) {
            return ((StringLiteralExpr) call.getArgument(0)).asString().toUpperCase(Locale.ROOT);
        }
        return null;
    }

    private List<String> extractXmlSearchTags(
            MethodDeclaration md,
            Map<String, List<MethodDeclaration>> methodsByName) {
        List<String> tags = new ArrayList<>();
        for (MethodCallExpr call : md.findAll(MethodCallExpr.class)) {
            String name = call.getNameAsString();
            if (isXmlSearchFind(name) && call.getArguments().size() == 2
                    && call.getArgument(1) instanceof StringLiteralExpr) {
                tags.add(((StringLiteralExpr) call.getArgument(1)).asString().toUpperCase(Locale.ROOT));
                continue;
            }
            List<MethodDeclaration> helpers = methodsByName.get(name);
            if (helpers != null) {
                for (MethodDeclaration helper : helpers) {
                    if (helper.getParameters().size() == call.getArguments().size()) {
                        int tagParamIdx = findXmlSearchTagParamIndex(helper);
                        if (tagParamIdx >= 0 && call.getArgument(tagParamIdx) instanceof StringLiteralExpr) {
                            tags.add(((StringLiteralExpr) call.getArgument(tagParamIdx)).asString().toUpperCase(Locale.ROOT));
                        }
                    }
                }
            }
        }
        return tags;
    }

    private int findXmlSearchTagParamIndex(MethodDeclaration helper) {
        List<Parameter> params = helper.getParameters();
        for (MethodCallExpr call : helper.findAll(MethodCallExpr.class)) {
            if (isXmlSearchFind(call.getNameAsString())
                    && call.getArguments().size() == 2
                    && call.getArgument(1) instanceof NameExpr) {
                String targetParam = ((NameExpr) call.getArgument(1)).getNameAsString();
                for (int i = 0; i < params.size(); i++) {
                    if (params.get(i).getNameAsString().equals(targetParam)) {
                        return i;
                    }
                }
            }
        }
        return -1;
    }

    private static boolean isXmlSearchFind(String methodName) {
        return methodName.equals("findFromAncestorByTagName")
                || methodName.equals("findAllFromAncestorByTagName");
    }

    private int collectSwitchTagPathEntries(
            TypeDeclaration<?> cls,
            String mapperClass,
            String tagPrefix,
            DomainCatalog domainCatalog,
            Set<String> dedup,
            List<SetterKeyEntry> results) {
        int extracted = 0;
        Map<String, List<MethodDeclaration>> methodsByName = indexMethodsByName(cls);
        for (MethodDeclaration md : cls.getMethods()) {
            Map<String, String> varTypes = collectMethodVarTypes(md);
            Set<String> methodPrefixes = resolveMethodPrefixes(md, methodsByName);
            for (SwitchStmt sw : md.findAll(SwitchStmt.class)) {
                if (!sw.getSelector().toString().contains("getTagPath")) {
                    continue;
                }
                for (SwitchEntry se : sw.getEntries()) {
                    List<String> keys = new ArrayList<>();
                    for (Expression label : se.getLabels()) {
                        if (label instanceof StringLiteralExpr) {
                            keys.add(((StringLiteralExpr) label).asString().toUpperCase(Locale.ROOT));
                        }
                    }
                    if (keys.isEmpty()) {
                        continue;
                    }
                    for (MethodCallExpr call : se.findAll(MethodCallExpr.class)) {
                        String callName = call.getNameAsString();
                        if (!callName.startsWith("set") || callName.length() <= 3) {
                            continue;
                        }
                        String dtoType = resolveSetterTargetDtoType(call, varTypes);
                        String field = domainCatalog.resolveFieldName(dtoType, stripSetPrefix(callName));
                        for (String key : keys) {
                            if (key.startsWith(tagPrefix + ".") || methodPrefixes.isEmpty()) {
                                addEntry(dedup, results, key, lastSegment(key), mapperClass, field);
                                extracted += 1;
                            } else {
                                for (String prefix : methodPrefixes) {
                                    addEntry(dedup, results, prefix + "." + key, lastSegment(key), mapperClass, field);
                                    extracted += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
        return extracted;
    }

    private static Map<String, String> collectMethodVarTypes(MethodDeclaration md) {
        Map<String, String> types = new java.util.HashMap<>();
        for (Parameter p : md.getParameters()) {
            types.put(p.getNameAsString(), p.getType().asString());
        }
        for (VariableDeclarationExpr vde : md.findAll(VariableDeclarationExpr.class)) {
            String typeName = vde.getElementType().asString();
            for (VariableDeclarator vd : vde.getVariables()) {
                types.put(vd.getNameAsString(), typeName);
            }
        }
        return types;
    }

    private static String resolveSetterTargetDtoType(MethodCallExpr call, Map<String, String> varTypes) {
        Expression scope = call.getScope().orElse(null);
        if (scope instanceof NameExpr) {
            return varTypes.getOrDefault(((NameExpr) scope).getNameAsString(), "");
        }
        return "";
    }

    private void collectDirectXmlSearchEntries(
            TypeDeclaration<?> cls,
            String mapperClass,
            String tagPrefix,
            Set<String> dedup,
            List<SetterKeyEntry> results) {
        Map<String, List<MethodDeclaration>> methodsByName = indexMethodsByName(cls);
        for (MethodDeclaration md : cls.getMethods()) {
            List<String> bases = extractEqualsIgnoreCasePaths(md);
            List<String> tags = extractXmlSearchTags(md, methodsByName);
            List<String> exactTagPaths = extractDirectTagPathEquals(md, tagPrefix);
            if (!exactTagPaths.isEmpty()) {
                for (String full : exactTagPaths) {
                    if (!bases.contains(full)) {
                        String leaf = lastSegment(full);
                        addEntry(dedup, results, full, leaf, mapperClass, leaf.toLowerCase(Locale.ROOT));
                    }
                }
            }
            for (String base : bases) {
                for (String tag : tags) {
                    String full = base.endsWith("." + tag) ? base : base + "." + tag;
                    addEntry(dedup, results, full, tag, mapperClass, tag.toLowerCase(Locale.ROOT));
                }
            }
        }
    }

    private static List<String> extractDirectTagPathEquals(MethodDeclaration md, String tagPrefix) {
        List<String> found = new ArrayList<>();
        String prefixDot = tagPrefix + ".";
        for (MethodCallExpr call : md.findAll(MethodCallExpr.class)) {
            if (!call.getNameAsString().equals("equals") || call.getArguments().size() != 1) {
                continue;
            }
            Expression scope = call.getScope().orElse(null);
            Expression arg = call.getArgument(0);
            if (scope instanceof StringLiteralExpr && arg.toString().contains("getTagPath")) {
                String path = ((StringLiteralExpr) scope).asString().toUpperCase(Locale.ROOT);
                if (path.startsWith(prefixDot)) {
                    found.add(path);
                }
            }
        }
        return found;
    }

    private Map<String, List<MethodDeclaration>> indexMethodsByName(TypeDeclaration<?> cls) {
        Map<String, List<MethodDeclaration>> map = new LinkedHashMap<>();
        for (MethodDeclaration md : cls.getMethods()) {
            map.computeIfAbsent(md.getNameAsString(), k -> new ArrayList<>()).add(md);
        }
        return map;
    }

    private Set<String> findReferencedMaps(MethodDeclaration md, Set<String> mapNames) {
        Set<String> found = new LinkedHashSet<>();
        for (NameExpr ne : md.findAll(NameExpr.class)) {
            if (mapNames.contains(ne.getNameAsString())) {
                found.add(ne.getNameAsString());
            }
        }
        return found;
    }

    private static void addEntry(
            Set<String> dedup,
            List<SetterKeyEntry> results,
            String fullTagPath,
            String leafTag,
            String mapperClass,
            String targetDtoField) {
        String key = fullTagPath + "|" + mapperClass + "|" + targetDtoField;
        if (dedup.add(key)) {
            results.add(new SetterKeyEntry(fullTagPath, leafTag, mapperClass, targetDtoField));
        }
    }

    private static String stripSetPrefix(String methodName) {
        return methodName.startsWith("set") ? methodName.substring(3) : methodName;
    }

    private static String lastSegment(String tagPath) {
        int idx = tagPath.lastIndexOf('.');
        return idx >= 0 ? tagPath.substring(idx + 1) : tagPath;
    }
}
