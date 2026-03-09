import styles from "./UnderConstruction.module.css";
import { useMediaQuery } from "../../utils/hooks/useMediaQuery";
import { Layout } from "../../components/Layout/Layout";

export const UnderConstructionPage = () => {
  const isMobile = useMediaQuery("(max-width: 768px)");
  return (
    <div className={styles.wrapper}>
      <h3 className={styles.heading}>Этот раздел пока в разработке</h3>
      <h6 className={styles.subheading}>но вы можете посмотреть гайды!</h6>
      {isMobile ? (
        <img src="/uc-mobile-capy.webp" />
      ) : (
        <img src="/uc-desktop-capy-edit.webp" />
      )}
    </div>
  );
};
