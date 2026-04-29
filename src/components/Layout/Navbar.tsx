import { useState, useRef, useEffect } from "react";
import ProfkomLogo from "../profkomLogo";
import { Icon } from "../Icon";
import styles from "./Navbar.module.css";
import { Link } from "react-router-dom";
import { getDocRoute, getHomeRoute } from "../../utils/routes";
import { useMediaQuery } from "../../utils/hooks/useMediaQuery";
import { pages } from "../../utils/routes";


export const Navbar = () => {
  const isMobile = useMediaQuery("(max-width: 768px)");
  
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      // Если клик был не по меню, закрываем его
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("touchstart", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [isOpen]);

  const handleMenuClick = () => {
    if (isMobile && !isOpen) {
      setIsOpen(true);
    }
  };

  return (
    <div className={styles.wrapper}>
      
      <div 
        className={`${styles.menu} ${isOpen ? styles.open : ""}`} 
        ref={menuRef}
        onClick={handleMenuClick}
      >
        <span className={styles.menuLabel}>меню</span>

        <ul className={styles.menuList}>
          {pages.map((item) => {
            return (
              <li className={styles.menuItem} key={item.name}>
                <Link
                  className={styles.menuLink}
                  to={getDocRoute(item.name)}
                  data-text={item.text}
                  onClick={() => isMobile && setIsOpen(false)} 
                >
                  <span>{item.text}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <div className={styles.logoWrapper}>
        <Link className={styles.logoLink} to={getHomeRoute()}>
          <ProfkomLogo variant={isMobile ? "mobile" : "desktop"} />
        </Link>
      </div>

      <div className={styles.profile}>
        <Link className={styles.logoLink} to={"/profile"}>
        <Icon size={isMobile ? 40 : 60} filled={true} name="account_circle" />
        </Link>
      </div>
    </div>
  );
};