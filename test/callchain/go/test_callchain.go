package main

import (
	"database/sql"
	"fmt"
	"os/exec"
)

// TestSqlInjection tests SQL injection sink detection
func TestSqlInjection(userInput string) {
	db, _ := sql.Open("mysql", "user:password@/dbname")
	defer db.Close()

	// This should be detected as a sink match
	query := "SELECT * FROM users WHERE name = '" + userInput + "'"
	db.Query(query)
	db.Exec(query)
}

// TestCommandInjection tests command injection sink detection
func TestCommandInjection(command string) {
	// This should be detected as a sink match
	cmd := exec.Command("sh", "-c", command)
	output, err := cmd.Output()
	if err != nil {
		panic(err)
	}
	fmt.Println(string(output))
}

func main() {
	TestSqlInjection("admin")
	TestCommandInjection("ls -la")
}
