<?php
// 调用链：函数嵌套调用 sink
function executeQuery($input) {
    $query = "SELECT * FROM users WHERE name = " . $input;
    mysqli_query($conn, $query);
}

function handleRequest() {
    $userInput = $_GET['name'];
    executeQuery($userInput);
}

handleRequest();
?>
