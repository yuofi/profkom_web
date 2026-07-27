import styles from "./UnderConstruction.module.css";
import { useMediaQuery } from "../../utils/hooks/useMediaQuery";
import { Image } from "../../components/Image/Image";
import { Helmet } from "react-helmet-async";

export const NotFoundPage = () => {
  const isMobile = useMediaQuery("(max-width: 768px)");
  return (
    <div className={styles.globalWrapper}>
      <Helmet>
        <title>404: Страница не найдена | Профком ВМК</title>
      </Helmet>
    <div className={styles.wrapper}>
      <h3 className={styles.heading}>Такой страницы не существует!</h3>
      {isMobile ? (
          <Image src="/nf-mobile-capy.webp" disableModal={true} />
        ) : (
            <Image src="/nf-desktop-capy.webp" disableModal={true} />
        )}
    </div>
    </div>
  );
};

export default NotFoundPage;