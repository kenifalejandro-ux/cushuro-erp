<?php
// api/dashboard.php
header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json; charset=UTF-8");

require_once 'config/database.php'; // Usa el archivo de conexión que creamos antes

try {
    // 1. KPIs de Repuestos
    $kpis = $pdo->query("
        SELECT 
            COUNT(*) as total_repuestos,
            SUM(CASE WHEN stock <= stock_minimo THEN 1 ELSE 0 END) as stock_bajo,
            COALESCE(SUM(stock * precio), 0) as valor_inventario
        FROM repuestos
    ")->fetch();

    // 2. KPIs de Documentos
    $docs = $pdo->query("
        SELECT COUNT(*) as vencidos 
        FROM documentos 
        WHERE fecha_vencimiento < CURDATE()
    ")->fetch();

    // 3. Nivel de Combustible
    $tanque = $pdo->query("SELECT nivel_actual, capacidad_total FROM tanques LIMIT 1")->fetch();
    $porcentajeCombustible = $tanque ? round(($tanque['nivel_actual'] / $tanque['capacidad_total']) * 100) : 0;

    // 4. Respuesta unificada para React
    echo json_encode([
        "total_repuestos" => (int)$kpis['total_repuestos'],
        "stock_critico" => (int)$kpis['stock_bajo'],
        "valor_total" => (float)$kpis['valor_inventario'],
        "documentos_vencidos" => (int)$docs['vencidos'],
        "combustible" => $porcentajeCombustible
    ]);

} catch (PDOException $e) {
    echo json_encode(["error" => $e->getMessage()]);
}
