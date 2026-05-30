import { useState, useRef, useEffect } from "react";
import ProfkomLogo from "../profkomLogo";
import styles from "./Navbar.module.css";
import { Link } from "react-router-dom";
import { getDocRoute, getHomeRoute } from "../../utils/routes";
import { useMediaQuery } from "../../utils/hooks/useMediaQuery";
import { useGuides } from "../../utils/hooks/useGuides";
import type { GuideOut } from "../../utils/api/types";
import { useMe } from "../../utils/me";
import { Avatar } from "../Avatar/Avatar";


export const Navbar = () => {
  const isMobile = useMediaQuery("(max-width: 768px)");
  const { data: guides } = useGuides();
  const user = useMe();
  
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
      <div className={styles.logoWrapper}>
        <Link className={`${styles.logoLink} ${styles.logo}`} to={getHomeRoute()}>
          <ProfkomLogo variant={isMobile ? "mobile" : "desktop"} 
          strokeWidth={isMobile ? 25 : 20}/>
        </Link>
      </div>

      <div 
        className={`${styles.menu} ${isOpen ? styles.open : ""}`} 
        ref={menuRef}
        onClick={handleMenuClick}
      >
        <span className={styles.menuLabel}>меню</span>

        <ul className={styles.menuList}>
          {guides?.map((item: GuideOut) => {
            return (
              <li className={styles.menuItem} key={item.guide_id}>
                <Link
                  className={styles.menuLink}
                  to={getDocRoute(item.guide_id)}
                  data-text={item.title}
                  onClick={() => isMobile && setIsOpen(false)} 
                >
                  <span>{item.title}</span>
                </Link>
              </li>
            );
          })}
        
        <li className={styles.menuItem} key={"info"}>
          <Link
            className={styles.menuLink}
            to={"/info"}
            data-text={"информация"}
            onClick={() => isMobile && setIsOpen(false)} 
          >
            <span>информация</span>
          </Link>
        </li>
        </ul>
      </div>

      <div className={styles.profile}>
        <Link className={`${styles.logoLink} ${styles.profileIcon}`} to={"/profile"}>
          <Avatar src={user?.photo_url} size={isMobile ? 40 : 60} />
        </Link>
      </div>
    </div>
  );
};
