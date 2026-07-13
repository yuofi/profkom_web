import { Outlet } from "react-router-dom";
import { Navbar } from "./Navbar"; 
import styles from "./Layout.module.css";

export const Layout = () => {
  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <Navbar />
      </header>

      <main className={styles.main}>
        <Outlet />
      </main>
      
    </div>
  );
};