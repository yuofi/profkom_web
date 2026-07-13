import styles from "./UnderConstruction.module.css";
import { useMediaQuery } from "../../utils/hooks/useMediaQuery";
import { Image } from "../../components/Image/Image";

export const UnderConstructionPage = () => {
  const isMobile = useMediaQuery("(max-width: 768px)");
  return (
    <div className={styles.wrapper}>
      <h3 className={styles.heading}>Этот раздел пока в разработке</h3>
      <h6 className={styles.subheading}>но вы можете посмотреть гайды!</h6>
      {isMobile ? (
        <Image src="/uc-mobile-capy.webp" disableModal={true} />
      ) : (
        <Image src="/uc-desktop-capy-edit.webp" disableModal={true} />
      )}
    </div>
  );
};
