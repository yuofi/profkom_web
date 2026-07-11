import { CardLabel } from "../CardLabel/CardLabel";
import { Button } from "../Button/Button";
import styles from "./NewsCard.module.css";
import clsx from "clsx";
import { Image } from "../Image/Image";

interface NewsCardProps {
  variant: "news" | "event" | "important";
  date: string;
  picLink?: string;
  heading: string;
  text: string;
  hasButton: boolean;
  footerText?: string;
}

const LABELS = {
  important: {
    cardVariant: "primary",
    cardText: "важное",
    iconName: "Notifications",
  },
  event: {
    cardVariant: "secondary",
    cardText: "событие",
    iconName: "Event",
  },
  news: {
    cardVariant: "tertiary",
    cardText: "новости",
    iconName: "News",
  },
} as const;

export const NewsCard = ({
  variant,
  date,
  picLink,
  heading,
  text,
  hasButton,
  footerText,
}: NewsCardProps) => {
  const { cardVariant, cardText, iconName } = LABELS[variant];

  return (
    <div className={clsx(styles.container, variant === 'important' && styles.borderPrimary, 
        styles[variant]
    )}>
      <div className={styles.header}>
        <CardLabel variant={cardVariant} iconName={iconName}>
          {cardText}
        </CardLabel>
        <h3 className={styles.date}>
            {date}
        </h3>
      </div>
      <div className={styles.main}>
      {picLink && (
        <Image src={picLink} alt="picture" />
      )}
      <h3 className={styles.heading}>{heading}</h3>
      <p className={styles.text}>{text}</p>
      </div>
      <div className={styles.footer}>
        {hasButton && (
            <Button variant={cardVariant} onClick={()=>console.log("clicked")}>
                записаться
            </Button>
        )}
        <h3>{footerText}</h3>
        <h3>подробнее</h3>
      </div>
    </div>
  );
};
