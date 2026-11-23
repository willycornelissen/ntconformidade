package br.gov.mg.fazenda.ntc.ast;

import br.gov.mg.fazenda.ntc.model.OracleCliException;
import br.gov.mg.fazenda.ntc.model.OracleDtos.JsonPropertyEntry;
import br.gov.mg.fazenda.ntc.model.OracleDtos.TableFieldEntry;
import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MemberValuePair;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.SingleMemberAnnotationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.expr.VariableDeclarationExpr;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Analisador AST para DTOs de domínio ({@code @JsonProperty}) e parsers/modelos tabulares.
 */
public final class DtoAndTableAstAnalyzer {

    public static final class DomainCatalog {
        private final Map<String, Map<String, String>> fieldsByClass;
        private final List<JsonPropertyEntry> jsonProperties;

        private DomainCatalog(
                Map<String, Map<String, String>> fieldsByClass,
                List<JsonPropertyEntry> jsonProperties) {
            this.fieldsByClass = fieldsByClass;
            this.jsonProperties = jsonProperties;
        }

        public String resolveFieldName(String className, String setterSuffix) {
            if (setterSuffix == null || setterSuffix.isEmpty()) {
                return "";
            }
            String simpleClass = stripPackagePrefix(className);
            Map<String, String> classFields = fieldsByClass.get(simpleClass);
            if (classFields != null) {
                String exact = classFields.get(setterSuffix.toLowerCase(Locale.ROOT));
                if (exact != null) {
                    return exact;
                }
            }
            return decapitalize(setterSuffix);
        }

        public List<JsonPropertyEntry> getJsonProperties() {
            return jsonProperties;
        }
    }

    public DomainCatalog inspectDomainPackage(Path srcMainJava, String domainPackage) {
        Path pkgDir = requireExistingPackageDir(srcMainJava, domainPackage, "domainPackage");
        Map<String, Map<String, String>> fieldsByClass = new HashMap<>();
        List<JsonPropertyEntry> jsonProperties = new ArrayList<>();

        for (Path javaFile : listJavaFiles(pkgDir)) {
            CompilationUnit cu = parseFile(javaFile);
            for (TypeDeclaration<?> type : cu.getTypes()) {
                inspectDomainType(type, fieldsByClass, jsonProperties);
            }
        }
        return new DomainCatalog(fieldsByClass, jsonProperties);
    }

    public List<TableFieldEntry> inspectTables(
            Path srcMainJava,
            String parserPackage,
            String tablePackage) {
        Map<String, Map<String, String>> tableFieldsByClass = loadTableFields(srcMainJava, tablePackage);
        Path parserDir = packageDir(srcMainJava, parserPackage);
        Set<String> dedupKeys = new LinkedHashSet<>();
        List<TableFieldEntry> results = new ArrayList<>();

        for (Path javaFile : listJavaFiles(parserDir)) {
            CompilationUnit cu = parseFile(javaFile);
            inspectParserTableCalls(cu, tableFieldsByClass, dedupKeys, results);
        }
        return results;
    }

    public CompilationUnit parseFile(Path javaFile) {
        ParserConfiguration config = new ParserConfiguration();
        config.setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_17);
        config.setCharacterEncoding(StandardCharsets.UTF_8);
        JavaParser parser = new JavaParser(config);
        try {
            ParseResult<CompilationUnit> parsed = parser.parse(javaFile);
            if (!parsed.isSuccessful() || !parsed.getResult().isPresent()) {
                throw new OracleCliException(2, "Falha ao analisar AST Java: " + javaFile);
            }
            return parsed.getResult().get();
        } catch (IOException e) {
            throw new OracleCliException(2, "Falha ao ler arquivo Java: " + javaFile, e);
        }
    }

    public Path requireExistingPackageDir(Path srcMainJava, String pkgName, String label) {
        Path dir = packageDir(srcMainJava, pkgName);
        if (dir == null || !Files.isDirectory(dir)) {
            throw new OracleCliException(2, "Diretório de pacote obrigatório não encontrado (" + label + "): " + dir);
        }
        return dir;
    }

    public List<Path> listJavaFiles(Path dir) {
        if (dir == null || !Files.isDirectory(dir, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            return Collections.emptyList();
        }
        Path rootReal;
        try {
            rootReal = dir.toRealPath();
        } catch (IOException e) {
            throw new OracleCliException(2, "Erro ao resolver diretório Java: " + dir, e);
        }
        try (Stream<Path> walk = Files.walk(dir)) {
            return walk.filter(p -> !Files.isSymbolicLink(p))
                    .filter(p -> Files.isRegularFile(p, java.nio.file.LinkOption.NOFOLLOW_LINKS))
                    .filter(p -> p.getFileName().toString().endsWith(".java"))
                    .filter(p -> {
                        try {
                            Path real = p.toRealPath();
                            if (!real.startsWith(rootReal)) {
                                return false;
                            }
                            for (Path seg : rootReal.relativize(real)) {
                                if ("test-files".equalsIgnoreCase(seg.toString())) {
                                    return false;
                                }
                            }
                            return true;
                        } catch (IOException ex) {
                            return false;
                        }
                    })
                    .sorted()
                    .collect(Collectors.toList());
        } catch (IOException e) {
            throw new OracleCliException(2, "Erro ao listar Java em: " + dir, e);
        }
    }

    public Path packageDir(Path srcMainJava, String pkgName) {
        if (pkgName == null || pkgName.trim().isEmpty()) {
            return null;
        }
        String trimmed = pkgName.trim();
        if (trimmed.contains("/") || trimmed.contains("\\") || trimmed.contains("..")) {
            throw new OracleCliException(2, "Nome de pacote inválido: " + pkgName);
        }
        Path resolved = srcMainJava.resolve(trimmed.replace('.', '/')).normalize();
        if (!resolved.startsWith(srcMainJava.normalize())) {
            throw new OracleCliException(2, "Pacote fora de src/main/java: " + pkgName);
        }
        return resolved;
    }

    private void inspectDomainType(
            TypeDeclaration<?> type,
            Map<String, Map<String, String>> fieldsByClass,
            List<JsonPropertyEntry> jsonProperties) {
        String className = type.getNameAsString();
        Map<String, String> fieldMap = fieldsByClass.computeIfAbsent(className, k -> new HashMap<>());

        if (type instanceof RecordDeclaration) {
            for (Parameter param : ((RecordDeclaration) type).getParameters()) {
                String name = param.getNameAsString();
                fieldMap.put(name.toLowerCase(Locale.ROOT), name);
                extractJsonPropertyValue(param.getAnnotations()).ifPresent(json -> {
                    if (!NonXsdFieldFilter.isExcludedField(name, className)) {
                        jsonProperties.add(new JsonPropertyEntry(className, name, json));
                    }
                });
            }
        }

        for (FieldDeclaration fd : type.getFields()) {
            Optional<String> jsonProp = extractJsonPropertyValue(fd.getAnnotations());
            for (VariableDeclarator var : fd.getVariables()) {
                String fieldName = var.getNameAsString();
                fieldMap.put(fieldName.toLowerCase(Locale.ROOT), fieldName);
                if (jsonProp.isPresent() && !NonXsdFieldFilter.isExcludedField(fieldName, className)) {
                    jsonProperties.add(new JsonPropertyEntry(className, fieldName, jsonProp.get()));
                }
            }
        }
    }

    private Optional<String> extractJsonPropertyValue(List<AnnotationExpr> annotations) {
        for (AnnotationExpr ann : annotations) {
            String annName = stripPackagePrefix(ann.getNameAsString());
            if (!annName.equals("JsonProperty")) {
                continue;
            }
            if (ann instanceof SingleMemberAnnotationExpr) {
                Expression val = ((SingleMemberAnnotationExpr) ann).getMemberValue();
                if (val instanceof StringLiteralExpr) {
                    return Optional.of(((StringLiteralExpr) val).asString());
                }
            } else if (ann instanceof NormalAnnotationExpr) {
                for (MemberValuePair pair : ((NormalAnnotationExpr) ann).getPairs()) {
                    if (pair.getNameAsString().equals("value")
                            && pair.getValue() instanceof StringLiteralExpr) {
                        return Optional.of(((StringLiteralExpr) pair.getValue()).asString());
                    }
                }
            }
        }
        return Optional.empty();
    }

    private Map<String, Map<String, String>> loadTableFields(Path srcMainJava, String tablePackage) {
        Map<String, Map<String, String>> byClass = new HashMap<>();
        Path tableDir = packageDir(srcMainJava, tablePackage);
        for (Path javaFile : listJavaFiles(tableDir)) {
            CompilationUnit cu = parseFile(javaFile);
            for (TypeDeclaration<?> type : cu.getTypes()) {
                Map<String, String> fields = byClass.computeIfAbsent(type.getNameAsString(), k -> new HashMap<>());
                for (FieldDeclaration fd : type.getFields()) {
                    for (VariableDeclarator var : fd.getVariables()) {
                        String name = var.getNameAsString();
                        fields.put(name.toLowerCase(Locale.ROOT), name);
                    }
                }
            }
        }
        return byClass;
    }

    private void inspectParserTableCalls(
            CompilationUnit cu,
            Map<String, Map<String, String>> tableFieldsByClass,
            Set<String> dedupKeys,
            List<TableFieldEntry> results) {
        for (TypeDeclaration<?> type : cu.getTypes()) {
            Map<String, String> classFields = collectClassFieldTypes(type);
            for (MethodDeclaration md : type.getMethods()) {
                Map<String, String> scopeTypes = buildMethodVarTypes(classFields, md);
                inspectMethodTableCalls(md, scopeTypes, tableFieldsByClass, dedupKeys, results);
            }
        }
    }

    private void inspectMethodTableCalls(
            MethodDeclaration md,
            Map<String, String> scopeTypes,
            Map<String, Map<String, String>> tableFieldsByClass,
            Set<String> dedupKeys,
            List<TableFieldEntry> results) {
        for (MethodCallExpr call : md.findAll(MethodCallExpr.class)) {
            String builderTable = resolveBuilderTableRoot(call, scopeTypes);
            if (builderTable != null && builderTable.endsWith("Table")) {
                String method = call.getNameAsString();
                if (!method.equals("builder") && !method.equals("build")) {
                    String resolved = resolveTableFieldName(tableFieldsByClass, builderTable, method);
                    addTableField(builderTable, resolved, dedupKeys, results);
                }
                continue;
            }
            Expression scope = call.getScope().orElse(null);
            if (scope instanceof NameExpr) {
                String varName = ((NameExpr) scope).getNameAsString();
                String tableClass = stripPackagePrefix(scopeTypes.get(varName));
                String method = call.getNameAsString();
                if (tableClass != null && tableClass.endsWith("Table") && method.startsWith("set") && method.length() > 3) {
                    String resolved = resolveTableFieldName(tableFieldsByClass, tableClass, method.substring(3));
                    addTableField(tableClass, resolved, dedupKeys, results);
                }
            }
        }
    }

    private Map<String, String> collectClassFieldTypes(TypeDeclaration<?> type) {
        Map<String, String> map = new HashMap<>();
        for (FieldDeclaration fd : type.getFields()) {
            String typeName = fd.getElementType().asString();
            for (VariableDeclarator vd : fd.getVariables()) {
                map.put(vd.getNameAsString(), typeName);
            }
        }
        return map;
    }

    private Map<String, String> buildMethodVarTypes(Map<String, String> classFields, MethodDeclaration md) {
        Map<String, String> map = new HashMap<>(classFields);
        for (Parameter p : md.getParameters()) {
            map.put(p.getNameAsString(), p.getType().asString());
        }
        for (VariableDeclarationExpr vde : md.findAll(VariableDeclarationExpr.class)) {
            String typeName = vde.getElementType().asString();
            for (VariableDeclarator vd : vde.getVariables()) {
                if (typeName.equals("var") && vd.getInitializer().isPresent()
                        && vd.getInitializer().get() instanceof MethodCallExpr) {
                    String root = resolveBuilderTableRoot((MethodCallExpr) vd.getInitializer().get(), map);
                    if (root != null) {
                        map.put(vd.getNameAsString(), root + ".Builder");
                        continue;
                    }
                }
                map.put(vd.getNameAsString(), typeName);
            }
        }
        return map;
    }

    private String resolveBuilderTableRoot(MethodCallExpr call, Map<String, String> scopeTypes) {
        Expression cursor = call;
        while (cursor instanceof MethodCallExpr) {
            MethodCallExpr m = (MethodCallExpr) cursor;
            Expression scope = m.getScope().orElse(null);
            if (scope == null) {
                return null;
            }
            if (m.getNameAsString().equals("builder")) {
                return extractSimpleTableName(scope);
            }
            cursor = scope;
        }
        if (cursor instanceof NameExpr) {
            String varType = scopeTypes.get(((NameExpr) cursor).getNameAsString());
            if (varType != null && varType.endsWith("Table.Builder")) {
                return stripPackagePrefix(varType.substring(0, varType.length() - ".Builder".length()));
            }
        }
        return null;
    }

    private static String extractSimpleTableName(Expression expr) {
        String text = expr.toString();
        int dot = text.lastIndexOf('.');
        return dot >= 0 ? text.substring(dot + 1) : text;
    }

    private String resolveTableFieldName(
            Map<String, Map<String, String>> tableFieldsByClass,
            String tableClass,
            String rawFieldOrSetterSuffix) {
        Map<String, String> fields = tableFieldsByClass.get(tableClass);
        if (fields != null) {
            String exact = fields.get(rawFieldOrSetterSuffix.toLowerCase(Locale.ROOT));
            if (exact != null) {
                return exact;
            }
        }
        return decapitalize(rawFieldOrSetterSuffix);
    }

    private void addTableField(
            String tableClass,
            String fieldName,
            Set<String> dedupKeys,
            List<TableFieldEntry> results) {
        if (NonXsdFieldFilter.isExcludedField(fieldName, tableClass)) {
            return;
        }
        String key = tableClass + "#" + fieldName;
        if (dedupKeys.add(key)) {
            results.add(new TableFieldEntry(tableClass, fieldName));
        }
    }

    private static String stripPackagePrefix(String typeName) {
        if (typeName == null) {
            return null;
        }
        int dot = typeName.lastIndexOf('.');
        return dot >= 0 ? typeName.substring(dot + 1) : typeName;
    }

    private static String decapitalize(String text) {
        if (text == null || text.isEmpty()) {
            return "";
        }
        if (text.length() == 1) {
            return text.toLowerCase(Locale.ROOT);
        }
        return Character.toLowerCase(text.charAt(0)) + text.substring(1);
    }
}
