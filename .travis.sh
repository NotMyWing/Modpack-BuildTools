# Exit on any error
set -e

git clone $MODPACKREPO modpack

cd ./modpack 
git checkout $BRANCH 
git reset --hard $COMMITHASH 

cd ..

gulp