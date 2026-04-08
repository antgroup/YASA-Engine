import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;

public class TestCallchain {
    
    public void testSqlInjection(String userInput) {
        try {
            Connection conn = DriverManager.getConnection("jdbc:mysql://localhost:3306/test");
            Statement stmt = conn.createStatement();
            // This should be detected as a sink match
            String query = "SELECT * FROM users WHERE name = '" + userInput + "'";
            stmt.executeQuery(query);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
    
    public void testCommandInjection(String command) {
        try {
            // This should be detected as a sink match
            Runtime.getRuntime().exec(command);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
    
    public static void main(String[] args) {
        TestCallchain test = new TestCallchain();
        test.testSqlInjection("admin");
        test.testCommandInjection("ls -la");
    }
}
