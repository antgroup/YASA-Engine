<?php
// XSS：$_POST -> echo
$name = $_POST['name'];
echo $name;
?>
