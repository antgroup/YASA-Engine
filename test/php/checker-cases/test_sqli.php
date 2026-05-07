<?php
// SQL 注入：$_GET -> mysqli_query
$id = $_GET['id'];
$query = "SELECT * FROM users WHERE id = " . $id;
mysqli_query($conn, $query);
?>
