import boto3
from botocore.config import Config
import uuid
from settings import settings

s3_client = boto3.client(
    "s3",
    endpoint_url=settings.S3_ENDPOINT,
    aws_access_key_id=f"{settings.S3_TENANT_ID}:{settings.S3_ACCESS_KEY}", 
    aws_secret_access_key=settings.S3_SECRET_KEY,
    region_name=settings.S3_REGION_NAME,
    config=Config(signature_version='s3v4')
)

from typing import Optional

def generate_presigned_url(folder: str, content_type: str, file_name: Optional[str] = None) -> dict[str, str]:
    """Генерирует временную ссылку для прямой загрузки файла"""
    if file_name and "." in file_name:
        file_extension = file_name.rsplit(".", 1)[-1].lower()
    else:
        file_extension = content_type.split("/")[-1]
        
    import urllib.parse
    import re
    
    if file_name and folder in ('pgas', 'guides'):
        # Убираем опасные символы, но оставляем пробелы и кириллицу
        safe_name = re.sub(r'[^a-zA-Z0-9а-яА-ЯёЁ_. \-]', '_', file_name)
        object_name = f"{folder}/{safe_name}"
    else:
        if file_extension == "jpeg":
            file_extension = "jpg"
        elif file_extension == "vnd.openxmlformats-officedocument.wordprocessingml.document":
            file_extension = "docx"
        elif file_extension == "msword":
            file_extension = "doc"
            
        object_name = f"{folder}/{uuid.uuid4()}.{file_extension}"
    

    presigned_url = s3_client.generate_presigned_url(
        ClientMethod='put_object',
        Params={
            'Bucket': settings.S3_BUCKET_NAME,
            'Key': object_name,
            'ContentType': content_type,
        },
        ExpiresIn=300
    )
    
    # domain_only = settings.S3_ENDPOINT.replace('https://', '').replace('http://', '').rstrip('/')
    # base_url = settings.S3_ENDPOINT.rstrip('/')
    public_url = f"https://global.s3.cloud.ru/{settings.S3_BUCKET_NAME}/{urllib.parse.quote(object_name, safe='/')}"
    
    return {
        "upload_url": presigned_url,
        "public_url": public_url
    }

def upload_image_from_url(url: str, folder: str = "avatars") -> str:
    """Загружает картинку по ссылке в S3 и возвращает публичную ссылку."""
    import urllib.request
    import logging

    if not url:
        return None

    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as response:
            image_bytes = response.read()
            content_type = response.headers.get('Content-Type', 'image/jpeg')
            
            file_extension = content_type.split("/")[-1]
            if file_extension == "jpeg":
                file_extension = "jpg"
            elif file_extension == "vnd.openxmlformats-officedocument.wordprocessingml.document":
                file_extension = "docx"
            elif file_extension == "msword":
                file_extension = "doc"
            
            object_name = f"{folder}/{uuid.uuid4()}.{file_extension}"
            
            s3_client.put_object(
                Bucket=settings.S3_BUCKET_NAME,
                Key=object_name,
                Body=image_bytes,
                ContentType=content_type
            )
            
            public_url = f"https://global.s3.cloud.ru/{settings.S3_BUCKET_NAME}/{object_name}"
            return public_url
    except Exception as e:
        logging.error(f"Failed to upload image from {url} to S3: {e}")
        return None