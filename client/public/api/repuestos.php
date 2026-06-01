<?php
// 1. Cabeceras obligatorias para API JSON y CORS
header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json; charset=UTF-8");
header("Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With");

// Si es una petición OPTIONS (pre-flight), terminar aquí
if ($_SERVER['REQUEST_METHOD'] == 'OPTIONS') exit;

// 2. Configuración de la Base de Datos (MySQL de SiteGround)
$host = 'localhost';
$db   = 'nombre_de_tu_bd'; 
$user = 'usuario_de_tu_bd';
$pass = 'password_de_tu_bd';

try {
    $pdo = new PDO("mysql:host=$host;dbname=$db;charset=utf8", $user, $pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch (PDOException $e) {
    echo json_encode(["error" => "No se pudo conectar a la base de datos"]);
    exit;
}

// 3. Obtener el método y el ID (si existe)
$method = $_SERVER['REQUEST_METHOD'];
$id = isset($_GET['id']) ? intval($_GET['id']) : null;

switch($method) {
    
    case 'GET':
        if (isset($_GET['action']) && $_GET['action'] == 'kpis') {
            // Lógica para los cuadritos del Dashboard
            $sql = "SELECT 
                (SELECT COUNT(*) FROM repuestos) AS total_repuestos,
                (SELECT COUNT(*) FROM repuestos WHERE stock <= stock_minimo) AS stock_bajo,
                (SELECT COALESCE(SUM(stock * precio),0) FROM repuestos) AS valor_inventario";
            $stmt = $pdo->query($sql);
            echo json_encode($stmt->fetch(PDO::FETCH_ASSOC));
        } else {
            // Listar todos los repuestos (Igual que tu findAll de Node)
            $stmt = $pdo->query("SELECT id, codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio, fecha_creacion AS fecha FROM repuestos ORDER BY id DESC");
            echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
        }
        break;

    case 'POST':
        // Crear nuevo repuesto (Igual que tu create)
        $data = json_decode(file_get_contents("php://input"), true);
        $sql = "INSERT INTO repuestos (codigo, nombre, categoria, stock, stock_minimo, stock_maximo, precio, fecha_creacion) 
                VALUES (?, ?, ?, ?, ?, ?, ?, NOW())";
        $pdo->prepare($sql)->execute([
            $data['codigo'], $data['nombre'], $data['categoria'], 
            $data['stock'], $data['stock_minimo'], $data['stock_maximo'], $data['precio']
        ]);
        echo json_encode(["message" => "Registro exitoso", "id" => $pdo->lastInsertId()]);
        break;

    case 'PUT':
        // Actualizar repuesto (Igual que tu update)
        if (!$id) { echo json_encode(["error" => "ID no proporcionado"]); break; }
        $data = json_decode(file_get_contents("php://input"), true);
        $sql = "UPDATE repuestos SET codigo=?, nombre=?, categoria=?, stock=?, stock_minimo=?, stock_maximo=?, precio=? WHERE id=?";
        $pdo->prepare($sql)->execute([
            $data['codigo'], $data['nombre'], $data['categoria'], 
            $data['stock'], $data['stock_minimo'], $data['stock_maximo'], $data['precio'], $id
        ]);
        echo json_encode(["message" => "Actualizado correctamente"]);
        break;

    case 'DELETE':
        // Eliminar repuesto (Igual que tu delete)
        if (!$id) { echo json_encode(["error" => "ID no proporcionado"]); break; }
        $pdo->prepare("DELETE FROM repuestos WHERE id = ?")->execute([$id]);
        echo json_encode(["message" => "Eliminado con éxito"]);
        break;
}
