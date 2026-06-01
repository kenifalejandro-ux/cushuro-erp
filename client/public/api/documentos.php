<?php
// api/documentos.php
header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json; charset=UTF-8");
header("Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With");

if ($_SERVER['REQUEST_METHOD'] == 'OPTIONS') exit;

// CONFIGURACIÓN DB (Cámbialo con tus datos de SiteGround)
$host = 'localhost';
$db   = 'tu_base_de_datos';
$user = 'tu_usuario';
$pass = 'tu_password';

try {
    $pdo = new PDO("mysql:host=$host;dbname=$db;charset=utf8", $user, $pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch (PDOException $e) {
    echo json_encode(["error" => $e->getMessage()]); exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$id = isset($_GET['id']) ? intval($_GET['id']) : null;

switch($method) {
    case 'GET':
        // Listar y calcular estados directamente en el backend para ahorrar lógica en React
        $stmt = $pdo->query("SELECT id, nombre_documento, responsable, fecha_vencimiento FROM documentos ORDER BY fecha_vencimiento ASC");
        $docs = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        $hoy = new DateTime();
        foreach ($docs as &$doc) {
            $venc = new DateTime($doc['fecha_vencimiento']);
            $diff = $hoy->diff($venc);
            $esPasado = $venc < $hoy;
            
            if ($esPasado) {
                $doc['estado'] = "VENCIDO";
            } elseif ($diff->days <= 15) {
                $doc['estado'] = "POR VENCER";
            } else {
                $doc['estado'] = "VIGENTE";
            }
        }
        echo json_encode($docs);
        break;

    case 'POST':
        $data = json_decode(file_get_contents("php://input"), true);
        $sql = "INSERT INTO documentos (nombre_documento, responsable, fecha_vencimiento) VALUES (?, ?, ?)";
        $pdo->prepare($sql)->execute([
            $data['nombre_documento'], 
            $data['responsable'], 
            $data['fecha_vencimiento']
        ]);
        echo json_encode(["id" => $pdo->lastInsertId()]);
        break;

    case 'PUT':
        if (!$id) break;
        $data = json_decode(file_get_contents("php://input"), true);
        $sql = "UPDATE documentos SET nombre_documento=?, responsable=?, fecha_vencimiento=? WHERE id=?";
        $pdo->prepare($sql)->execute([
            $data['nombre_documento'], $data['responsable'], $data['fecha_vencimiento'], $id
        ]);
        echo json_encode(["status" => "success"]);
        break;

    case 'DELETE':
        if (!$id) break;
        $pdo->prepare("DELETE FROM documentos WHERE id=?")->execute([$id]);
        echo json_encode(["message" => "Eliminado"]);
        break;
}
