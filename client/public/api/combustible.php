<?php
// api/combustible.php
header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json; charset=UTF-8");
header("Access-Control-Allow-Methods: GET, PUT, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");

if ($_SERVER['REQUEST_METHOD'] == 'OPTIONS') exit;

// CONFIGURACIÓN DB
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

switch($method) {
    case 'GET':
        // Obtenemos el primer tanque registrado
        $stmt = $pdo->query("SELECT * FROM tanques LIMIT 1");
        $tanque = $stmt->fetch(PDO::FETCH_ASSOC);
        
        if ($tanque) {
            // Calcular porcentaje para el frontend
            $tanque['porcentaje'] = round(($tanque['nivel_actual'] / $tanque['capacidad_total']) * 100);
            echo json_encode($tanque);
        } else {
            echo json_encode(["error" => "No hay tanques configurados"]);
        }
        break;

    case 'PUT':
        $data = json_decode(file_get_contents("php://input"), true);
        // Actualizamos el nivel actual del tanque principal
        $sql = "UPDATE tanques SET nivel_actual = ? WHERE id = 1";
        $pdo->prepare($sql)->execute([$data['nivel_actual']]);
        echo json_encode(["status" => "Nivel actualizado"]);
        break;
}
