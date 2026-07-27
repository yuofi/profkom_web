import { useState, useRef, useEffect } from "react";
import ProfkomLogo from "../profkomLogo";
import styles from "./Navbar.module.css";
import { Link, useNavigate } from "react-router-dom";
import { getDocRoute, getHomeRoute } from "../../utils/routes";
import { useMediaQuery } from "../../utils/hooks/useMediaQuery";
import { useGuides } from "../../utils/hooks/useGuides";
import type { GuideOut } from "../../utils/api/types";
import { useMe } from "../../utils/me";
import { Avatar } from "../Avatar/Avatar";

import { Button } from "../Button/Button";

export const Navbar = () => {
  const navigate = useNavigate();
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


  return (
    <div className={styles.wrapper}>
      {isMobile ? (
        <>
          <div className={styles.mobileLeftSection} ref={menuRef}>
            <div 
              className={styles.mobileLogoBtn}
              onClick={() => setIsOpen(!isOpen)}
            >
              <ProfkomLogo variant="mobile" strokeWidth={25}/>
            </div>

            {isOpen && (
              <div className={styles.mobileDropdown}>

                <Button
                  variant="secondary"
                  className={styles.mobileDropdownBtn}
                  onClick={() => {
                    setIsOpen(false);
                    navigate("/");
                  }}
                >
                  главная
                </Button>

                {guides?.map((item: GuideOut) => (
                  <Button
                    key={item.guide_id}
                    variant="secondary"
                    className={styles.mobileDropdownBtn}
                    onClick={() => {
                      setIsOpen(false);
                      navigate(getDocRoute(item.guide_id));
                    }}
                  >
                    {item.title}
                  </Button>
                ))}
                <Button
                  variant="secondary"
                  className={styles.mobileDropdownBtn}
                  onClick={() => {
                    setIsOpen(false);
                    navigate("/info");
                  }}
                >
                  контакты
                </Button>
              </div>
            )}
          </div>

          <div className={styles.profile}>
            <Link className={`${styles.logoLink} ${styles.profileIcon}`} to={"/profile"}>
              <Avatar src={user?.photo_url} size={40} mode="disable"/>
            </Link>
          </div>
        </>
      ) : (
        <>
          <div className={styles.logoWrapper}>
            <Link className={`${styles.logoLink} ${styles.logo}`} to={getHomeRoute()}>
              <ProfkomLogo variant="desktop" strokeWidth={20}/>
            </Link>
          </div>

          <div 
            className={styles.menu} 
          >
            <span className={styles.menuLabel}>меню</span>

            <ul className={styles.menuList}>
              {guides && guides?.map((item: GuideOut) => (
                <li className={styles.menuItem} key={item.guide_id}>
                  <Link
                    className={styles.menuLink}
                    to={getDocRoute(item.guide_id)}
                    data-text={item.title}
                  >
                    <span>{item.title}</span>
                  </Link>
                </li>
              ))}
            
              <li className={styles.menuItem} key={"info"}>
                <Link
                  className={styles.menuLink}
                  to={"/info"}
                  data-text={"контакты"}
                >
                  <span>контакты</span>
                </Link>
              </li>
            </ul>
          </div>

          <div className={styles.profile}>
            <Link className={`${styles.logoLink} ${styles.profileIcon}`} to={"/profile"}>
              <Avatar src={user?.photo_url} size={40} mode="disable"/>
            </Link>
          </div>
        </>
      )}
    </div>
  );
};
