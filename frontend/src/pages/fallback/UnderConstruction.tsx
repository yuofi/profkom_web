import styles from "./UnderConstruction.module.css";
import { useMediaQuery } from "../../utils/hooks/useMediaQuery";
import { Image } from "../../components/Image/Image";
import { Helmet } from "react-helmet-async";

export const UnderConstructionPage = () => {
  const isMobile = useMediaQuery("(max-width: 768px)");
  return (
    <div className={styles.wrapper}>
      <Helmet>
        <title>Главная | Профком ВМК</title>
      </Helmet>
      <h3 className={styles.heading}>Этот раздел пока в разработке</h3>
      <h6 className={styles.subheading}>но вы можете посмотреть гайды!</h6>
      <a
        className={styles.subheadingLink}
        href="https://forms.gle/twMFBL6MNfR8oooi9"
        target="_blank"
        rel="noopener noreferrer"
      >
        А также предложить идею или оставить отзыв
      </a>
      {isMobile ? (
        <Image src="/uc-mobile-capy.webp" disableModal={true} />
      ) : (
        <Image src="/uc-desktop-capy-edit.webp" disableModal={true} />
      )}
    </div>
  );
};
